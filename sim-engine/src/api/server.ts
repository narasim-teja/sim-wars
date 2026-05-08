import "../bootstrap";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, open, appendFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { pathsFor, resolveRunPaths, isDemoRun, RUNS_DIR, DEMO_RUNS_DIR } from "../ipc/paths";
import { writeCommand } from "../ipc/command-reader";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";
import type { StatusSnapshot } from "../ipc/event-writer";
import { buildLLMClient } from "../llm/factory";
import { draftScenario } from "../scenarios/generator";
import { normalizeConfig } from "../scenarios/normalize";
import { perRunDeploymentPath } from "../chain/sdk";
import { buildDeploymentPlan } from "../chain/deployment-plan";
import { expandRoster, type RosterPreset } from "../agents/roster";
import { MAX_AGENTS, MAX_ONCHAIN_AGENTS, DEFAULT_AGENT_COUNT } from "../constants";
import {
  apiRateLimiter,
  fingerprintKey,
  getClientIp,
  type RateLimitConfig,
  type RateLimitDecision,
} from "./rate-limit";
import {
  isPlausibleOpenRouterKey,
  isPlausibleHeliusInput,
  normalizeHeliusUrl,
  PUBLIC_DEVNET_RPC,
} from "./byok";

interface SpawnedRun {
  simId: string;
  /** Worker subprocess. Null while the on-chain deploy step is still running. */
  process: Subprocess | null;
  startedAt: number;
  // Byte offset for incremental NDJSON tailing
  eventsOffset: number;
}

const runs = new Map<string, SpawnedRun>();
const wsClients = new Map<string, Set<{ send: (data: string) => void }>>(); // simId → sockets

// SIM_API_PORT takes precedence so we can override on platforms that
// reserve PORT for their own use (AWS App Runner injects PORT to match
// its forward-port and silently ignores attempts to override it).
const PORT = Number(process.env.SIM_API_PORT ?? process.env.PORT ?? 8787);
const WORKER_SCRIPT = resolve(import.meta.dir, "../worker/main.ts");
const DEPLOY_SCRIPT = resolve(import.meta.dir, "../../scripts/deploy-from-config.ts");

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

interface CreateSimBody {
  config: SimulationConfig;
  /**
   * Explicit roster — full control. When omitted, the server expands a
   * deterministic roster sized by `agentCount` using `rosterPreset`.
   */
  agents?: AgentPersona[];
  /** When `agents` is omitted, expand a roster of this size. Defaults to 20. */
  agentCount?: number;
  /** Archetype mix used by the expander. Defaults to "luna". */
  rosterPreset?: RosterPreset;
  extractionMeta?: {
    protocolName?: string;
    protocolKind?: string;
    tokenSymbol?: string;
    quoteSymbol?: string;
  };
  /**
   * Dotted paths the user grounded in the source OR explicitly edited in the
   * config form. Drives mode-aware deployment: programs whose section is
   * absent from this list are skipped on-chain. Omitted ⇒ legacy preset
   * behavior (deploy everything `onChain` implies).
   */
  extractedFields?: string[];
  tickConfig: TickConfig;
  onChain?: boolean;
  /**
   * Bring-your-own OpenRouter key. Forwarded to the spawned worker process
   * via env, never persisted to scenario.json or any log line. When the
   * server is started with `SIM_REQUIRE_BYOK=1` (production mode) this is
   * the only way to launch a non-demo run.
   */
  byokOpenRouterKey?: string;
  /**
   * Bring-your-own Helius RPC URL — optional. Same redaction contract as
   * `byokOpenRouterKey`: forwarded via env to the worker + deploy
   * subprocess as `ANCHOR_PROVIDER_URL` and stripped from scenario.json.
   * When omitted, on-chain runs use the public devnet endpoint
   * (`https://api.devnet.solana.com`), which works for small sims but
   * rate-limits at ~10 req/s. Heavy sims (50+ agents) need a Helius key.
   */
  byokHeliusUrl?: string;
}

const REQUIRE_BYOK = process.env.SIM_REQUIRE_BYOK === "1";
const DISABLE_ONCHAIN = process.env.SIM_DISABLE_ONCHAIN === "1";

// Rate-limit config: env-driven so production can tune without redeploying
// the image. BYOK protects our LLM bill; the limiter protects the App
// Runner instance from any caller spamming worker spawns.
const RATE_LIMIT_PER_IP: RateLimitConfig = {
  limit: Number(process.env.SIM_RATE_LIMIT_PER_IP ?? 10),
  windowMs: Number(process.env.SIM_RATE_LIMIT_WINDOW_MS ?? 3600_000),
};
const RATE_LIMIT_PER_KEY: RateLimitConfig = {
  limit: Number(process.env.SIM_RATE_LIMIT_PER_KEY ?? 20),
  windowMs: Number(process.env.SIM_RATE_LIMIT_WINDOW_MS ?? 3600_000),
};

// On-chain runs spend the deployer keypair's SOL (rent + tx fees) per sim, so
// they get a tighter cap than the general per-IP limit. With ~0.01 SOL/sim a
// 3/hour cap costs ≤0.72 SOL/day at full saturation across all callers.
const RATE_LIMIT_ONCHAIN_PER_IP: RateLimitConfig = {
  limit: Number(process.env.SIM_ONCHAIN_RATE_LIMIT_PER_IP ?? 3),
  windowMs: Number(process.env.SIM_RATE_LIMIT_WINDOW_MS ?? 3600_000),
};

/**
 * Standard `X-RateLimit-*` headers (non-RFC but the de-facto convention
 * everyone exposes — GitHub, Stripe, Cloudflare). On a 429 we also emit
 * `Retry-After` per RFC 7231 §7.1.3.
 */
function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(Math.floor(d.resetAtMs / 1000)),
  };
  if (!d.allowed) h["Retry-After"] = String(d.retryAfterSec);
  return h;
}

function rateLimit429(scope: "ip" | "key", d: RateLimitDecision): Response {
  const noun = scope === "ip" ? "IP" : "BYOK key";
  return json(
    {
      error: `rate limit exceeded: ${d.limit} sims per window per ${noun}. Retry in ${d.retryAfterSec}s.`,
      scope,
      retryAfterSec: d.retryAfterSec,
    },
    {
      status: 429,
      headers: { ...corsHeaders(), ...rateLimitHeaders(d) },
    },
  );
}

async function handleCreate(req: Request): Promise<Response> {
  // IP rate limit FIRST — before body parse — so malformed/oversized
  // payloads still count toward the cap. Otherwise an attacker could
  // bypass the limit by spamming junk payloads that fail validation.
  const ip = getClientIp(req);
  const ipDecision = apiRateLimiter.check(`ip:${ip}`, RATE_LIMIT_PER_IP);
  if (!ipDecision.allowed) return rateLimit429("ip", ipDecision);

  const body = (await req.json()) as CreateSimBody;
  if (!body.config || !body.tickConfig) {
    return json(
      { error: "config and tickConfig are required" },
      { status: 400, headers: { ...corsHeaders(), ...rateLimitHeaders(ipDecision) } },
    );
  }

  // BYOK: validate the OpenRouter key shape, then keep it ONLY in this
  // function's local scope. The persisted scenario.json never sees it; we
  // forward it to the spawned worker via env so it dies with the process.
  let byokKey: string | undefined;
  if (body.byokOpenRouterKey != null) {
    if (!isPlausibleOpenRouterKey(body.byokOpenRouterKey)) {
      return json(
        { error: "byokOpenRouterKey must look like an OpenRouter key (sk-or-...)" },
        { status: 400, headers: { ...corsHeaders(), ...rateLimitHeaders(ipDecision) } },
      );
    }
    byokKey = body.byokOpenRouterKey.trim();
  }

  // BYOK Helius — same redaction contract. Optional even for on-chain runs;
  // when omitted we fall back to the public devnet RPC, which is fine for
  // small sims and rate-limits gracefully on bigger ones.
  let byokHeliusUrl: string | undefined;
  if (body.byokHeliusUrl != null && body.byokHeliusUrl !== "") {
    if (!isPlausibleHeliusInput(body.byokHeliusUrl)) {
      return json(
        {
          error:
            "byokHeliusUrl must be a Helius URL (https://*.helius-rpc.com/?api-key=…) " +
            "or a bare API key (8–80 alphanumeric chars).",
        },
        { status: 400, headers: { ...corsHeaders(), ...rateLimitHeaders(ipDecision) } },
      );
    }
    byokHeliusUrl = normalizeHeliusUrl(body.byokHeliusUrl);
  }

  // Per-key cap is independent of per-IP — caught here so BYOK abusers
  // can't dodge by rotating IPs. Fingerprint avoids holding the full key
  // in the limiter map. Only enforced when a key is actually present.
  let keyDecision: RateLimitDecision | null = null;
  if (byokKey) {
    keyDecision = apiRateLimiter.check(`key:${fingerprintKey(byokKey)}`, RATE_LIMIT_PER_KEY);
    if (!keyDecision.allowed) return rateLimit429("key", keyDecision);
  }
  if (REQUIRE_BYOK && !byokKey) {
    return json(
      {
        error:
          "this server requires a bring-your-own OpenRouter key. " +
          "Pass `byokOpenRouterKey` in the request body. " +
          "Get a key at https://openrouter.ai/keys",
      },
      { status: 402, headers: corsHeaders() },
    );
  }
  if (DISABLE_ONCHAIN && body.onChain) {
    return json(
      { error: "on-chain runs are disabled on this deployment (SIM_DISABLE_ONCHAIN=1)" },
      { status: 400, headers: corsHeaders() },
    );
  }
  // Tighter cap for on-chain runs — each one spends server SOL (rent + tx
  // fees from the deployer keypair). Stacks on top of the general per-IP
  // limit checked above; an attacker hitting this 429 still consumed a
  // token from the general bucket.
  let onchainDecision: RateLimitDecision | null = null;
  if (body.onChain) {
    onchainDecision = apiRateLimiter.check(`onchain-ip:${ip}`, RATE_LIMIT_ONCHAIN_PER_IP);
    if (!onchainDecision.allowed) return rateLimit429("ip", onchainDecision);
  }
  // Worker treats `maxTicks=0` as "run forever" but in practice it short-
  // circuits to 0 ticks completed and ships an empty F-grade report —
  // confusing failure mode for users who fat-finger the field name (e.g.
  // `totalTicks` instead of `maxTicks`). Reject loudly at the boundary.
  const tc = body.tickConfig as Partial<TickConfig>;
  if (typeof tc.maxTicks !== "number" || !Number.isFinite(tc.maxTicks) || tc.maxTicks <= 0) {
    return json(
      {
        error: `tickConfig.maxTicks must be a positive number, got ${JSON.stringify(tc.maxTicks)}. ` +
          `If you sent 'totalTicks', the correct field is 'maxTicks'.`,
      },
      { status: 400 },
    );
  }
  if (typeof tc.intervalMs !== "number" || tc.intervalMs < 0) {
    return json(
      { error: `tickConfig.intervalMs must be a non-negative number, got ${JSON.stringify(tc.intervalMs)}` },
      { status: 400 },
    );
  }

  // Coalesce sparse extraction output (`amm: {}` etc.) to a fully-populated
  // config before we hand it to the worker or the deploy script. Without
  // this, downstream code reads `undefined` for fields the schema is
  // supposed to default — was the bug behind resilience reading 51 instead
  // of 91 last run.
  let normalizedConfig: SimulationConfig;
  try {
    const rawConfig =
      body.config && typeof body.config === "object"
        ? { ...(body.config as unknown as Record<string, unknown>) }
        : body.config;
    if (rawConfig && typeof rawConfig === "object" && body.extractionMeta) {
      const rc = rawConfig as Record<string, unknown>;
      rc.metadata = {
        ...(rc.metadata && typeof rc.metadata === "object" ? rc.metadata as Record<string, unknown> : {}),
        ...body.extractionMeta,
      };
    }
    normalizedConfig = normalizeConfig(rawConfig);
  } catch (e) {
    return json({ error: `config normalization failed: ${(e as Error).message}` }, { status: 400 });
  }

  const simId = crypto.randomUUID();

  // Roster: explicit `agents` wins; otherwise expand from agentCount + preset.
  let resolvedAgents: AgentPersona[];
  if (Array.isArray(body.agents) && body.agents.length > 0) {
    resolvedAgents = body.agents;
  } else {
    const count = body.agentCount ?? DEFAULT_AGENT_COUNT;
    if (!Number.isInteger(count) || count <= 0) {
      return json({ error: `agentCount must be a positive integer, got ${count}` }, { status: 400 });
    }
    if (count > MAX_AGENTS) {
      return json(
        { error: `agentCount ${count} exceeds MAX_AGENTS=${MAX_AGENTS}. Edit constants.ts to raise the cap.` },
        { status: 400 },
      );
    }
    try {
      resolvedAgents = expandRoster({
        count,
        preset: body.rosterPreset,
        simId,
      });
    } catch (e) {
      return json({ error: `roster expansion failed: ${(e as Error).message}` }, { status: 400 });
    }
    if (resolvedAgents.length === 0) {
      return json({ error: "roster expander produced 0 agents — bad ratios?" }, { status: 500 });
    }
  }

  // On-chain cap: deployer SOL + devnet RPC don't scale to MAX_AGENTS, so
  // the public website is held to a tighter ceiling. Self-hosted users can
  // raise it via SIM_ONCHAIN_MAX_AGENTS.
  if (body.onChain && resolvedAgents.length > MAX_ONCHAIN_AGENTS) {
    return json(
      {
        error:
          `on-chain runs are capped at ${MAX_ONCHAIN_AGENTS} agents on this deployment ` +
          `(got ${resolvedAgents.length}). Off-chain runs can use up to ${MAX_AGENTS}. ` +
          `For larger on-chain runs, self-host: the codebase is open-source — set ` +
          `SIM_ONCHAIN_MAX_AGENTS to your desired cap.`,
      },
      { status: 400, headers: corsHeaders() },
    );
  }

  const deploymentPlan = buildDeploymentPlan({
    config: normalizedConfig,
    agents: resolvedAgents,
    onChain: !!body.onChain,
    extractedFields: Array.isArray(body.extractedFields) ? body.extractedFields : undefined,
  });
  if (body.onChain && deploymentPlan.blockers.length > 0) {
    return json(
      { error: `deployment preflight failed: ${deploymentPlan.blockers.join("; ")}`, deploymentPlan },
      { status: 400 },
    );
  }

  // Persist the resolved roster + normalized config, not the request body, so
  // worker + deploy script see the exact same shape the API committed to.
  // CRITICAL: strip both BYOK fields so they never land on disk. They travel
  // in-memory to the worker via spawn env and die with the process.
  const persistedBody: CreateSimBody = {
    ...body,
    config: normalizedConfig,
    agents: resolvedAgents,
  };
  delete persistedBody.byokOpenRouterKey;
  delete persistedBody.byokHeliusUrl;

  const paths = pathsFor(simId);
  mkdirSync(paths.commandsDir, { recursive: true });
  mkdirSync(dirname(paths.scenarioFile), { recursive: true });

  writeFileSync(paths.scenarioFile, JSON.stringify(persistedBody, null, 2));
  writeFileSync(paths.statusFile, JSON.stringify({ simId, status: "starting", tick: 0, updatedAt: Date.now() }));
  // Touch events file so tailers can open it immediately
  writeFileSync(paths.eventsFile, "");

  // Track the run before any async deploy so WS clients connecting in the
  // gap between deploy + worker spawn can subscribe and tail events.
  runs.set(simId, { simId, process: null, startedAt: Date.now(), eventsOffset: 0 });

  // Per-run env passed to the worker (and deploy) subprocesses. BYOK secrets
  // live ONLY here and in the spawned process — they go away when it exits.
  // ANCHOR_PROVIDER_URL is the canonical Anchor knob and resolveRpcUrl()
  // reads it before any other source.
  const workerEnv: Record<string, string> = {};
  if (byokKey) workerEnv.OPENROUTER_API_KEY = byokKey;
  if (body.onChain) {
    // Default to the public devnet RPC if no BYOK key was supplied. Without
    // this, on-chain runs would fall back to localhost (DEFAULT_RPC) inside
    // the container and immediately fail.
    workerEnv.ANCHOR_PROVIDER_URL = byokHeliusUrl ?? PUBLIC_DEVNET_RPC;
  }

  if (body.onChain) {
    // Fire-and-forget the deploy → worker chain. The HTTP response returns
    // immediately so the frontend can subscribe to /ws/sim/:id and watch
    // the chain:deploy:* events stream in.
    runDeployThenWorker(simId, persistedBody, deploymentPlan, workerEnv).catch((err) => {
      appendEvent(paths.eventsFile, {
        kind: "chain:deploy:error",
        ts: Date.now(),
        simId,
        message: (err as Error).message,
      });
      writeFileSync(
        paths.statusFile,
        JSON.stringify({ simId, status: "failed", tick: 0, updatedAt: Date.now() }),
      );
    });
  } else {
    spawnWorker(simId, workerEnv);
  }

  // Echo rate-limit state on the success path too — clients can self-pace
  // off `X-RateLimit-Remaining` instead of waiting for a 429. When BYOK
  // is in play we surface the tighter of the two windows (key cap is
  // typically larger than IP cap, but never assume).
  const surfaceDecision: RateLimitDecision =
    keyDecision !== null && keyDecision.remaining < ipDecision.remaining
      ? keyDecision
      : ipDecision;
  return json(
    { simId, status: "starting", agentCount: resolvedAgents.length, deploymentPlan },
    { status: 201, headers: { ...corsHeaders(), ...rateLimitHeaders(surfaceDecision) } },
  );
}

function appendEvent(eventsFile: string, event: object): void {
  appendFileSync(eventsFile, JSON.stringify(event) + "\n");
}

function spawnWorker(simId: string, extraEnv: Record<string, string> = {}): void {
  const proc = spawn({
    cmd: ["bun", "run", WORKER_SCRIPT, "--sim-id", simId],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SIM_ID: simId, ...extraEnv },
  });
  const existing = runs.get(simId);
  runs.set(simId, {
    simId,
    process: proc,
    startedAt: existing?.startedAt ?? Date.now(),
    eventsOffset: existing?.eventsOffset ?? 0,
  });
}

async function runDeployThenWorker(
  simId: string,
  body: CreateSimBody,
  plan: { programs: { staking: boolean; governance: boolean } },
  workerEnv: Record<string, string> = {},
): Promise<void> {
  const paths = pathsFor(simId);
  appendEvent(paths.eventsFile, { kind: "chain:deploy:start", ts: Date.now(), simId, step: "starting" });

  // Honor the deployment plan from buildDeploymentPlan — when the user
  // didn't extract or edit any staking / governance fields, those programs
  // are skipped here too. Backstop: even with `extractedFields` undefined
  // (legacy callers), `plan.programs` still defaults to "deploy everything
  // an on-chain run needs", matching the previous behavior.
  const withStaking = plan.programs.staking;
  const withGovernance = plan.programs.governance;

  const deployArgs = [
    "run", DEPLOY_SCRIPT,
    "--scenario", paths.scenarioFile,
    "--sim-id", simId,
    "--out", perRunDeploymentPath(simId),
  ];
  if (withStaking) deployArgs.push("--with-staking");
  if (withGovernance) deployArgs.push("--with-governance");

  appendEvent(paths.eventsFile, {
    kind: "chain:deploy:progress", ts: Date.now(), simId, step: "running",
    message: `bun ${deployArgs.join(" ")}`,
  });

  const proc = spawn({
    cmd: ["bun", ...deployArgs],
    stdout: "pipe",
    stderr: "pipe",
    // Merge workerEnv (carries the BYOK Helius URL when supplied) so the
    // deploy script's `getProvider()` picks the right RPC. Without this it
    // would fall back to whatever `ANCHOR_PROVIDER_URL` the API process
    // inherited (typically empty → localhost).
    env: { ...process.env, ...workerEnv },
  });

  // Tee stdout/stderr into the events stream as progress lines so the UI can
  // show what's happening without blocking the HTTP response.
  void streamToEvents(proc.stdout, paths.eventsFile, simId, "deploy.stdout");
  void streamToEvents(proc.stderr, paths.eventsFile, simId, "deploy.stderr");

  const exit = await proc.exited;
  if (exit !== 0) {
    appendEvent(paths.eventsFile, {
      kind: "chain:deploy:error", ts: Date.now(), simId,
      message: `deploy script exited with ${exit}`,
    });
    writeFileSync(
      paths.statusFile,
      JSON.stringify({ simId, status: "failed", tick: 0, updatedAt: Date.now() }),
    );
    return;
  }

  const programs = ["tokenMint", "ammDex", ...(withStaking ? ["staking"] : []), ...(withGovernance ? ["governance"] : [])];
  appendEvent(paths.eventsFile, {
    kind: "chain:deploy:complete", ts: Date.now(), simId, programs,
  });

  spawnWorker(simId, { ...workerEnv, CHAIN_DEPLOYMENT: perRunDeploymentPath(simId) });
}

async function streamToEvents(
  stream: ReadableStream<Uint8Array> | undefined,
  eventsFile: string,
  simId: string,
  step: string,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        appendEvent(eventsFile, {
          kind: "chain:deploy:progress", ts: Date.now(), simId, step, message: line,
        });
      }
    }
  }
}

function handleCommand(simId: string, type: "pause" | "resume" | "abort"): Response {
  if (isDemoRun(simId)) {
    return json(
      { error: "demo runs are read-only — pause/resume/abort have no effect" },
      { status: 409, headers: corsHeaders() },
    );
  }
  const run = runs.get(simId);
  if (!run) return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  const paths = pathsFor(simId);
  writeCommand(paths.commandsDir, { type });
  return json({ ok: true, simId, command: type }, { headers: corsHeaders() });
}

function handleStatus(simId: string): Response {
  const paths = resolveRunPaths(simId);
  if (!existsSync(paths.statusFile)) return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  const snap = JSON.parse(readFileSync(paths.statusFile, "utf-8")) as StatusSnapshot;
  return json(
    { ...snap, hasReport: existsSync(paths.reportFile), isDemo: isDemoRun(simId) },
    { headers: corsHeaders() },
  );
}

function handleReport(simId: string): Response {
  const paths = resolveRunPaths(simId);
  if (!existsSync(paths.statusFile)) {
    return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  }
  if (!existsSync(paths.reportFile)) {
    return json({ error: "report not ready" }, { status: 404, headers: corsHeaders() });
  }
  const report = JSON.parse(readFileSync(paths.reportFile, "utf-8"));
  return json(report, { headers: corsHeaders() });
}

/**
 * Demo metadata served from a hand-curated table. Demo runs are read-only
 * NDJSON recordings baked into the image; this endpoint exposes a
 * friendly card-list to the frontend.
 */
interface DemoCard {
  simId: string;
  name: string;
  description: string;
  status: string;
  totalTicks: number;
  resilienceScore: number | null;
  resilienceGrade: string | null;
  deathSpiralDetected: boolean;
}

interface DemoMeta {
  name: string;
  description: string;
}

/**
 * Each demo directory may include a `meta.json` with `{ name, description }`.
 * Without it the demo still surfaces, but with placeholder copy. Adding a new
 * demo is therefore: (1) drop the run dir into `runs-demo/`, (2) write its
 * `meta.json` — no server-code change required.
 */
function readDemoMeta(simId: string): DemoMeta {
  const metaPath = join(DEMO_RUNS_DIR, simId, "meta.json");
  if (!existsSync(metaPath)) {
    return {
      name: `Demo ${simId.slice(0, 8)}`,
      description: "Pre-recorded simulation replay.",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<DemoMeta>;
    return {
      name: parsed.name?.trim() || `Demo ${simId.slice(0, 8)}`,
      description: parsed.description?.trim() || "Pre-recorded simulation replay.",
    };
  } catch {
    return {
      name: `Demo ${simId.slice(0, 8)}`,
      description: "Pre-recorded simulation replay (meta.json malformed).",
    };
  }
}

function handleDemos(): Response {
  if (!existsSync(DEMO_RUNS_DIR)) {
    return json({ demos: [] }, { headers: corsHeaders() });
  }
  const demos: DemoCard[] = [];
  for (const entry of readdirSync(DEMO_RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const simId = entry.name;
    const paths = pathsFor(simId, DEMO_RUNS_DIR);
    if (!existsSync(paths.statusFile)) continue;
    const snap = JSON.parse(readFileSync(paths.statusFile, "utf-8")) as StatusSnapshot;
    const meta = readDemoMeta(simId);
    let resilienceScore: number | null = null;
    let resilienceGrade: string | null = null;
    let deathSpiralDetected = false;
    let totalTicks = 0;
    if (existsSync(paths.reportFile)) {
      try {
        // The report writer nests run-shape fields (totalTicks,
        // deathSpiralDetected) under `meta`, while resilience fields stay
        // at the top level. Don't flatten — read each from its real path.
        const report = JSON.parse(readFileSync(paths.reportFile, "utf-8")) as {
          resilienceScore?: number;
          resilienceGrade?: string;
          meta?: { deathSpiralDetected?: boolean; totalTicks?: number };
        };
        resilienceScore = report.resilienceScore ?? null;
        resilienceGrade = report.resilienceGrade ?? null;
        deathSpiralDetected = !!report.meta?.deathSpiralDetected;
        totalTicks = report.meta?.totalTicks ?? snap.tick;
      } catch { /* fall through */ }
    }
    demos.push({
      simId,
      name: meta.name,
      description: meta.description,
      status: snap.status,
      totalTicks,
      resilienceScore,
      resilienceGrade,
      deathSpiralDetected,
    });
  }
  return json({ demos }, { headers: corsHeaders() });
}

/**
 * Boot-time scan of `runs-demo/` so demo simIds are registered in the
 * `runs` map and the WS handler can find them. We point `eventsOffset`
 * at the file size so the periodic tailer never re-emits — the on-connect
 * full-replay in `onWsOpen` is the only delivery path for demos.
 */
function registerDemos(): void {
  if (!existsSync(DEMO_RUNS_DIR)) return;
  for (const entry of readdirSync(DEMO_RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const simId = entry.name;
    const paths = pathsFor(simId, DEMO_RUNS_DIR);
    if (!existsSync(paths.eventsFile)) continue;
    const size = statSync(paths.eventsFile).size;
    runs.set(simId, { simId, process: null, startedAt: Date.now(), eventsOffset: size });
  }
}

async function handleDraftScenario(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { goal?: string } | null;
  if (!body || typeof body.goal !== "string" || body.goal.trim().length === 0) {
    return json({ error: "goal is required" }, { status: 400, headers: corsHeaders() });
  }
  try {
    const llm = buildLLMClient();
    const draft = await draftScenario(llm, body.goal);
    return json(draft, { headers: corsHeaders() });
  } catch (e) {
    return json(
      { error: (e as Error).message },
      { status: 500, headers: corsHeaders() },
    );
  }
}

function handleList(): Response {
  const items = Array.from(runs.keys()).map((simId) => {
    const paths = pathsFor(simId);
    const snap = existsSync(paths.statusFile)
      ? (JSON.parse(readFileSync(paths.statusFile, "utf-8")) as StatusSnapshot)
      : null;
    return { simId, status: snap?.status ?? "unknown", tick: snap?.tick ?? 0 };
  });
  return json({ runs: items }, { headers: corsHeaders() });
}

/**
 * Tail the NDJSON events file from `offset` and deliver each new line to all
 * subscribed WS clients for this run. Returns the new offset.
 */
async function tailEvents(simId: string): Promise<void> {
  const run = runs.get(simId);
  if (!run) return;
  // Demo runs are pre-registered with `eventsOffset` set to file size so this
  // is a no-op for them — `onWsOpen` is their only delivery path.
  const paths = resolveRunPaths(simId);
  if (!existsSync(paths.eventsFile)) return;
  const size = statSync(paths.eventsFile).size;
  if (size <= run.eventsOffset) return;

  const fd = await new Promise<number>((res, rej) => open(paths.eventsFile, "r", (err, f) => (err ? rej(err) : res(f))));
  try {
    const buf = Buffer.alloc(size - run.eventsOffset);
    const { readSync } = await import("node:fs");
    readSync(fd, buf, 0, buf.length, run.eventsOffset);
    run.eventsOffset = size;
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    const clients = wsClients.get(simId);
    if (!clients || clients.size === 0) return;
    for (const line of lines) {
      for (const c of clients) c.send(line);
    }
  } finally {
    const { closeSync } = await import("node:fs");
    closeSync(fd);
  }
}

function startTailers(): void {
  setInterval(() => {
    for (const simId of runs.keys()) tailEvents(simId).catch(() => {});
  }, 250);
}

function startRateLimitPruner(): void {
  // Sweep expired buckets every 5 min so the limiter map can't grow
  // unbounded on a long-running App Runner instance. One bucket lives
  // ~RATE_LIMIT_WINDOW_MS at most; pruning earlier just trims stale ones.
  setInterval(() => {
    apiRateLimiter.prune();
  }, 5 * 60_000);
}

function onWsOpen(ws: { data: { simId: string }; send: (d: string) => void }) {
  const { simId } = ws.data;
  if (!wsClients.has(simId)) wsClients.set(simId, new Set());
  wsClients.get(simId)!.add(ws as unknown as { send: (d: string) => void });
  // On connect, replay full history so the client catches up without polling.
  // resolveRunPaths falls back to the read-only `runs-demo/` dir, which is how
  // baked-in demo recordings get streamed to fresh clients.
  const paths = resolveRunPaths(simId);
  if (existsSync(paths.eventsFile)) {
    const text = readFileSync(paths.eventsFile, "utf-8");
    for (const line of text.split("\n")) if (line) ws.send(line);
  }
}

function onWsClose(ws: { data: { simId: string }; send: (d: string) => void }) {
  const set = wsClients.get(ws.data.simId);
  if (set) set.delete(ws as unknown as { send: (d: string) => void });
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server
// ────────────────────────────────────────────────────────────────────────────

mkdirSync(RUNS_DIR, { recursive: true });
registerDemos();
startTailers();
startRateLimitPruner();

interface WsData {
  simId: string;
}

const server = Bun.serve<WsData, never>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // WebSocket upgrade: /ws/sim/:id
    const wsMatch = url.pathname.match(/^\/ws\/sim\/([^/]+)$/);
    if (wsMatch) {
      const simId = wsMatch[1]!;
      const upgraded = srv.upgrade(req, { data: { simId } });
      if (upgraded) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, runs: runs.size });
    }

    if (req.method === "GET" && url.pathname === "/api/sim") {
      return handleList();
    }

    if (req.method === "POST" && url.pathname === "/api/sim") {
      return handleCreate(req);
    }

    if (req.method === "GET" && url.pathname === "/api/demos") {
      return handleDemos();
    }

    if (req.method === "POST" && url.pathname === "/api/scenarios/draft") {
      return handleDraftScenario(req);
    }

    const reportMatch = url.pathname.match(/^\/api\/sim\/([^/]+)\/report$/);
    if (reportMatch && req.method === "GET") {
      return handleReport(reportMatch[1]!);
    }

    const simMatch = url.pathname.match(/^\/api\/sim\/([^/]+)(?:\/(pause|resume|abort))?$/);
    if (simMatch) {
      const simId = simMatch[1]!;
      const action = simMatch[2] as "pause" | "resume" | "abort" | undefined;
      if (req.method === "POST" && action) return handleCommand(simId, action);
      if (req.method === "GET") return handleStatus(simId);
    }

    return new Response("not found", { status: 404, headers: corsHeaders() });
  },
  websocket: {
    open(ws) {
      onWsOpen(ws as unknown as { data: { simId: string }; send: (d: string) => void });
    },
    message() {
      /* client → server messages unused for now */
    },
    close(ws) {
      onWsClose(ws as unknown as { data: { simId: string }; send: (d: string) => void });
    },
  },
});

console.log(`sim-wars API listening on http://localhost:${server.port}`);
console.log(`  POST /api/sim                  — create new run`);
console.log(`  GET  /api/sim                  — list runs`);
console.log(`  GET  /api/sim/:id              — status snapshot`);
console.log(`  POST /api/sim/:id/pause        — pause`);
console.log(`  POST /api/sim/:id/resume       — resume`);
console.log(`  POST /api/sim/:id/abort        — abort`);
console.log(`  POST /api/scenarios/draft      — LLM-drafted SimulationConfig`);
console.log(`  GET  /api/sim/:id/report       — post-sim report (JSON)`);
console.log(`  WS   /ws/sim/:id               — event stream (NDJSON)`);
