import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimDatabase } from "../db/database";
import { MockProvider } from "../llm/providers/mock-provider";
import { runSimulation } from "./simulation";
import type { SimulationConfig, AgentPersona, TickConfig, LLMResponse } from "../types";

const tinyConfig: SimulationConfig = {
  token: { totalSupply: 1_000_000, decimals: 6, allocations: [{ name: "All", percent: 100, vestingMonths: 0 }] },
  staking: { baseAPY: 10, maxAPY: 10, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
  amm: { initialLiquidity: 100_000, initialPrice: 1.0, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
};

const agents: AgentPersona[] = [
  {
    id: "WHALE_TEST",
    type: "whale",
    name: "Test Whale",
    complexity: "reasoning",
    systemPrompt: "test whale",
    riskTolerance: 0.3,
    initialCapital: { token: 1000, usdc: 10_000, stakedFraction: 0.5 },
    goals: [],
  },
  {
    id: "DEGEN_TEST",
    type: "retail_degen",
    name: "Test Degen",
    complexity: "fast",
    systemPrompt: "test degen",
    riskTolerance: 0.8,
    initialCapital: { token: 500, usdc: 1_000, stakedFraction: 0 },
    goals: [],
  },
];

const tickConfig: TickConfig = { intervalMs: 0, maxTicks: 3 };

describe("runSimulation (end-to-end)", () => {
  it("runs 3 ticks through orchestrator + mock LLM, persists per-tick state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sim-wars-test-"));
    const db = new SimDatabase(join(tmp, "sim.sqlite"));

    const holdResp: LLMResponse = { action: "hold", amount: null, reasoning: "test", threat_assessment: "none" };
    const sellResp: LLMResponse = { action: "sell", amount: 100, reasoning: "test-sell", threat_assessment: "none" };

    const llm = new MockProvider({
      scripted: new Map([
        ["WHALE_TEST", sellResp],
        ["DEGEN_TEST", holdResp],
      ]),
    });

    const simId = crypto.randomUUID();
    const tickEvents: number[] = [];

    const summary = await runSimulation({
      simId,
      config: tinyConfig,
      agents,
      tickConfig,
      llm,
      db,
      onTickComplete: (r) => tickEvents.push(r.tick),
    });

    expect(summary.totalTicks).toBe(3);
    expect(tickEvents).toEqual([0, 1, 2]);
    expect(llm.calls.length).toBeGreaterThanOrEqual(6); // 2 agents × 3 ticks

    // Telemetry plumbing: orchestrator drains usage each tick and totals on
    // RunSimulationResult. Mock returns ZERO_USAGE except for `calls`, but
    // a non-zero call count proves the wire is connected end-to-end.
    expect(summary.llmUsage.calls).toBeGreaterThanOrEqual(6);
    expect(summary.llmUsage.costUsd).toBe(0); // mock has no cost

    // WHALE_TEST sold 100 tokens each of 3 ticks → 300 sold
    // The actions table should reflect those sells
    const whaleHistory = db.getAgentHistory(simId, "WHALE_TEST", 10);
    const sells = whaleHistory.filter((a) => a.action === "sell");
    expect(sells.length).toBe(3);

    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
