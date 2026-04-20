import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, open } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { pathsFor, RUNS_DIR } from "../ipc/paths";
import { writeCommand } from "../ipc/command-reader";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";
import type { StatusSnapshot } from "../ipc/event-writer";
import { buildLLMClient } from "../llm/factory";
import { draftScenario } from "../scenarios/generator";

interface SpawnedRun {
  simId: string;
  process: Subprocess;
  startedAt: number;
  // Byte offset for incremental NDJSON tailing
  eventsOffset: number;
}

const runs = new Map<string, SpawnedRun>();
const wsClients = new Map<string, Set<{ send: (data: string) => void }>>(); // simId → sockets

const PORT = Number(process.env.PORT ?? 8787);
const WORKER_SCRIPT = resolve(import.meta.dir, "../worker/main.ts");

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
  agents: AgentPersona[];
  tickConfig: TickConfig;
  onChain?: boolean;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateSimBody;
  if (!body.config || !body.agents || !body.tickConfig) {
    return json({ error: "config, agents, tickConfig are required" }, { status: 400 });
  }

  const simId = crypto.randomUUID();
  const paths = pathsFor(simId);
  mkdirSync(paths.commandsDir, { recursive: true });
  mkdirSync(dirname(paths.scenarioFile), { recursive: true });

  writeFileSync(paths.scenarioFile, JSON.stringify(body, null, 2));
  writeFileSync(paths.statusFile, JSON.stringify({ simId, status: "starting", tick: 0, updatedAt: Date.now() }));
  // Touch events file so tailers can open it immediately
  writeFileSync(paths.eventsFile, "");

  const proc = spawn({
    cmd: ["bun", "run", WORKER_SCRIPT, "--sim-id", simId],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, SIM_ID: simId },
  });

  runs.set(simId, { simId, process: proc, startedAt: Date.now(), eventsOffset: 0 });

  return json({ simId, status: "starting" }, { status: 201, headers: corsHeaders() });
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
  return json(snap, { headers: corsHeaders() });
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
console.log(`  WS   /ws/sim/:id               — event stream (NDJSON)`);
