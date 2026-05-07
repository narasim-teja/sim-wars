import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { resolve } from "node:path";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";

const PORT = 8799; // keep out of the way of the default 8787

const tinyConfig: SimulationConfig = {
  token: { totalSupply: 1_000_000, decimals: 6, allocations: [{ name: "All", percent: 100, vestingMonths: 0 }] },
  staking: { baseAPY: 10, maxAPY: 10, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
  amm: { initialLiquidity: 100_000, initialPrice: 1.0, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
};

const agents: AgentPersona[] = [
  {
    id: "WHALE_A", type: "whale", name: "A", complexity: "reasoning",
    systemPrompt: "a", riskTolerance: 0.3,
    initialCapital: { token: 1000, usdc: 10_000, stakedFraction: 0.5 },
    goals: [],
  },
  {
    id: "DEGEN_A", type: "retail_degen", name: "B", complexity: "fast",
    systemPrompt: "b", riskTolerance: 0.8,
    initialCapital: { token: 500, usdc: 1_000, stakedFraction: 0 },
    goals: [],
  },
];

const tickConfig: TickConfig = { intervalMs: 0, maxTicks: 3 };

let server: Subprocess | null = null;

beforeAll(async () => {
  server = spawn({
    cmd: ["bun", "run", resolve(import.meta.dir, "server.ts")],
    env: { ...process.env, LLM_PROVIDER: "mock", PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for the server to bind
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("api server did not become ready");
});

afterAll(() => {
  server?.kill();
});

describe("api server → worker integration", () => {
  it("expands a roster from agentCount when agents[] is omitted", async () => {
    const created = await fetch(`http://localhost:${PORT}/api/sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: tinyConfig,
        agentCount: 12,
        rosterPreset: "luna",
        tickConfig,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { simId: string; agentCount: number };
    expect(body.agentCount).toBe(12);
  }, 10000);

  it("rejects agentCount > MAX_AGENTS with 400", async () => {
    const created = await fetch(`http://localhost:${PORT}/api/sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: tinyConfig,
        agentCount: 9999,
        tickConfig,
      }),
    });
    expect(created.status).toBe(400);
    const body = (await created.json()) as { error: string };
    expect(body.error).toContain("MAX_AGENTS");
  }, 10000);

  it("spawns a worker that runs to completion and streams events via WS", async () => {
    const created = await fetch(`http://localhost:${PORT}/api/sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: tinyConfig, agents, tickConfig }),
    });
    expect(created.status).toBe(201);
    const { simId } = (await created.json()) as { simId: string };
    expect(simId).toMatch(/^[0-9a-f-]+$/i);

    // Subscribe via WebSocket — collect all events
    const events: string[] = [];
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/sim/${simId}`);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws connect timeout")), 5000);
      ws.addEventListener("open", () => { clearTimeout(t); res(); });
      ws.addEventListener("error", rej);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      events.push(String(ev.data));
    });

    // Poll status until completed or 10s pass
    let status = "starting";
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`http://localhost:${PORT}/api/sim/${simId}`);
      if (r.ok) {
        const s = (await r.json()) as { status: string };
        status = s.status;
        if (status === "completed" || status === "failed" || status === "interrupted") break;
      }
      await Bun.sleep(100);
    }
    expect(status).toBe("completed");

    // Give the tailer a moment to flush final events to WS
    await Bun.sleep(500);
    ws.close();

    const kinds = events
      .map((line) => { try { return JSON.parse(line).kind as string; } catch { return ""; } })
      .filter(Boolean);
    expect(kinds).toContain("sim:start");
    expect(kinds.filter((k) => k === "tick:complete").length).toBeGreaterThanOrEqual(3);
    expect(kinds).toContain("sim:complete");
  }, 20000);

  it("rejects malformed BYOK keys with 400", async () => {
    const r = await fetch(`http://localhost:${PORT}/api/sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: tinyConfig,
        agents,
        tickConfig,
        byokOpenRouterKey: "not-a-real-key",
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("byok");
  }, 10000);

  it("strips byokOpenRouterKey from the persisted scenario.json", async () => {
    const fakeKey = "sk-or-v1-" + "a".repeat(48);
    const r = await fetch(`http://localhost:${PORT}/api/sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: tinyConfig,
        agents,
        tickConfig,
        byokOpenRouterKey: fakeKey,
      }),
    });
    expect(r.status).toBe(201);
    const { simId } = (await r.json()) as { simId: string };
    // give the worker a tick to flush scenario.json (it's written synchronously
    // before spawn, but be safe across slow CI)
    await Bun.sleep(200);
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const scenarioPath = resolve(__dirname, "../../.local/runs", simId, "scenario.json");
    const raw = readFileSync(scenarioPath, "utf-8");
    expect(raw.includes(fakeKey)).toBe(false);
    expect(raw.includes("byokOpenRouterKey")).toBe(false);
  }, 10000);
});
