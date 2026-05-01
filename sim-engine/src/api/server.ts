import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, open, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { pathsFor, RUNS_DIR } from "../ipc/paths";
import { writeCommand } from "../ipc/command-reader";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";
import type { StatusSnapshot } from "../ipc/event-writer";
import { buildLLMClient } from "../llm/factory";
import { draftScenario } from "../scenarios/generator";
import { perRunDeploymentPath } from "../chain/sdk";
import { expandRoster, type RosterPreset } from "../agents/roster";
import { MAX_AGENTS, DEFAULT_AGENT_COUNT } from "../constants";

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

const PORT = Number(process.env.PORT ?? 8787);
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
  tickConfig: TickConfig;
  onChain?: boolean;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateSimBody;
  if (!body.config || !body.tickConfig) {
    return json({ error: "config and tickConfig are required" }, { status: 400 });
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

  // Persist the resolved roster, not the request body, so worker + deploy
  // script see the exact same agents the API committed to.
  const persistedBody: CreateSimBody = {
    ...body,
    agents: resolvedAgents,
  };

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

  if (body.onChain) {
    // Fire-and-forget the deploy → worker chain. The HTTP response returns
    // immediately so the frontend can subscribe to /ws/sim/:id and watch
    // the chain:deploy:* events stream in.
    runDeployThenWorker(simId, persistedBody).catch((err) => {
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
    spawnWorker(simId);
  }

  return json(
    { simId, status: "starting", agentCount: resolvedAgents.length },
    { status: 201, headers: corsHeaders() },
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

async function runDeployThenWorker(simId: string, body: CreateSimBody): Promise<void> {
  const paths = pathsFor(simId);
  appendEvent(paths.eventsFile, { kind: "chain:deploy:start", ts: Date.now(), simId, step: "starting" });

  // Decide which optional programs to deploy based on the config shape.
  // Staking is always useful when on-chain is requested. Governance only when
  // the config actually defines a meaningful proposal/quorum threshold.
  const withStaking = true;
  const withGovernance = body.config.governance.proposalThresholdPercent > 0
    && body.config.governance.quorumPercent > 0;

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
    env: process.env,
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

  spawnWorker(simId, { CHAIN_DEPLOYMENT: perRunDeploymentPath(simId) });
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
  const run = runs.get(simId);
  if (!run) return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  const paths = pathsFor(simId);
  writeCommand(paths.commandsDir, { type });
  return json({ ok: true, simId, command: type }, { headers: corsHeaders() });
}

function handleStatus(simId: string): Response {
  const paths = pathsFor(simId);
  if (!existsSync(paths.statusFile)) return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  const snap = JSON.parse(readFileSync(paths.statusFile, "utf-8")) as StatusSnapshot;
  return json({ ...snap, hasReport: existsSync(paths.reportFile) }, { headers: corsHeaders() });
}

function handleReport(simId: string): Response {
  const paths = pathsFor(simId);
  if (!existsSync(paths.statusFile)) {
    return json({ error: "unknown simId" }, { status: 404, headers: corsHeaders() });
  }
  if (!existsSync(paths.reportFile)) {
    return json({ error: "report not ready" }, { status: 404, headers: corsHeaders() });
  }
  const report = JSON.parse(readFileSync(paths.reportFile, "utf-8"));
  return json(report, { headers: corsHeaders() });
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
  const paths = pathsFor(simId);
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

function onWsOpen(ws: { data: { simId: string }; send: (d: string) => void }) {
  const { simId } = ws.data;
  if (!wsClients.has(simId)) wsClients.set(simId, new Set());
  wsClients.get(simId)!.add(ws as unknown as { send: (d: string) => void });
  // On connect, replay full history so the client catches up without polling
  const paths = pathsFor(simId);
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
startTailers();

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
