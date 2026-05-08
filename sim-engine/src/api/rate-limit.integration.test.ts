import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { resolve } from "node:path";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";

// Distinct from the main integration server (8799) so the two test files
// don't collide. SIM_RATE_LIMIT_PER_IP=2 means the third POST trips 429
// after exactly two worker spawns — keeps the test cheap.
const PORT = 8801;

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
];

const tickConfig: TickConfig = { intervalMs: 0, maxTicks: 1 };

const validBody = JSON.stringify({ config: tinyConfig, agents, tickConfig });

let server: Subprocess | null = null;

beforeAll(async () => {
  server = spawn({
    cmd: ["bun", "run", resolve(import.meta.dir, "server.ts")],
    env: {
      ...process.env,
      LLM_PROVIDER: "mock",
      PORT: String(PORT),
      SIM_RATE_LIMIT_PER_IP: "2",
      SIM_RATE_LIMIT_PER_KEY: "3",
      // 1h is the prod default; keep it large so a slow CI doesn't roll
      // the window between requests.
      SIM_RATE_LIMIT_WINDOW_MS: String(60 * 60_000),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("rate-limit api server did not become ready");
});

afterAll(() => {
  server?.kill();
});

async function postSim(headers: Record<string, string> = {}, body = validBody): Promise<Response> {
  return fetch(`http://localhost:${PORT}/api/sim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/sim rate limiting", () => {
  it("emits X-RateLimit-* headers on success and decrements remaining", async () => {
    // Source IP: this test owns 1.1.1.1
    const r1 = await postSim({ "x-forwarded-for": "1.1.1.1" });
    expect(r1.status).toBe(201);
    expect(r1.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("1");
    const reset = Number(r1.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const r2 = await postSim({ "x-forwarded-for": "1.1.1.1" });
    expect(r2.status).toBe(201);
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("0");
  }, 15000);

  it("returns 429 with Retry-After once the IP cap is exhausted", async () => {
    // Same source IP — already at 0 remaining from the prior test.
    const r3 = await postSim({ "x-forwarded-for": "1.1.1.1" });
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await r3.json()) as { error: string; scope: string };
    expect(body.scope).toBe("ip");
    expect(body.error.toLowerCase()).toContain("rate limit");
  }, 5000);

  it("isolates per-IP buckets — a different IP starts fresh", async () => {
    const r = await postSim({ "x-forwarded-for": "9.9.9.9" });
    expect(r.status).toBe(201);
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("1");
  }, 15000);

  it("trips 429 on the per-key bucket once the key cap is exhausted", async () => {
    const fakeKey = "sk-or-v1-" + "k".repeat(48); // last 8 = "kkkkkkkk"
    const headers = { "x-forwarded-for": "2.2.2.2" }; // fresh IP (its own bucket)
    const bodyWithKey = JSON.stringify({
      config: tinyConfig,
      agents,
      tickConfig,
      byokOpenRouterKey: fakeKey,
    });
    // Key cap = 3. To isolate the key check from the IP check (limit 2),
    // rotate IPs after the second hit so the per-IP bucket never traps
    // the request before the key check fires.
    expect((await postSim(headers, bodyWithKey)).status).toBe(201);
    expect((await postSim(headers, bodyWithKey)).status).toBe(201);
    expect((await postSim({ "x-forwarded-for": "3.3.3.3" }, bodyWithKey)).status).toBe(201);
    const r = await postSim({ "x-forwarded-for": "4.4.4.4" }, bodyWithKey);
    expect(r.status).toBe(429);
    const body = (await r.json()) as { scope: string };
    expect(body.scope).toBe("key");
  }, 20000);

  it("surfaces falsy x-forwarded-for entries safely (no IP → unknown bucket)", async () => {
    // A request with no XFF still goes through but shares the "unknown"
    // bucket. We just assert the server responds at all (other tests
    // already cover the 201/429 transition).
    const r = await postSim({}); // no XFF — likely first hit on "unknown"
    expect([201, 429]).toContain(r.status);
  }, 15000);
});
