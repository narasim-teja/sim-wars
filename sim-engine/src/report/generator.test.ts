import { describe, expect, it } from "bun:test";
import { generateReport } from "./generator";
import { MockProvider } from "../llm/providers/mock-provider";
import { SimDatabase } from "../db/database";
import type { SimulationConfig, AgentPersona, SimulationState, AgentAction } from "../types";

function tmpDb(): SimDatabase {
  return new SimDatabase(`/tmp/sim-wars-test-${Math.random().toString(36).slice(2)}.sqlite`);
}

const baseConfig: SimulationConfig = {
  token: { totalSupply: 1_000_000_000, decimals: 6, allocations: [] },
  staking: { baseAPY: 19.45, maxAPY: 19.45, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
  amm: { initialLiquidity: 100_000_000, initialPrice: 85, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 0.1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
  stablecoin: { enabled: true, targetPeg: 1, mintBurnRatio: 1, reserveAmount: 3_000_000_000 },
};

const agents: AgentPersona[] = [
  {
    id: "WHALE_01", type: "whale", name: "Whale", systemPrompt: "", riskTolerance: 0.3,
    initialCapital: { token: 50_000_000, usdc: 10_000_000 }, goals: [],
  },
  {
    id: "FARMER_01", type: "yield_farmer", name: "Farmer", systemPrompt: "", riskTolerance: 0.5,
    initialCapital: { token: 20_000_000, usdc: 2_000_000 }, goals: [],
  },
];

function seed(db: SimDatabase, simId: string) {
  db.createSimulation(simId, baseConfig);
  // Two ticks: starts at $85, ends at $0.10 (death-spiral territory)
  const states: SimulationState[] = [
    {
      tick: 0, tokenPrice: 85, priceHistory: [85], totalSupply: 1_000_000_000,
      circulatingSupply: 1_000_000_000, stakedSupply: 200_000_000, stakingAPY: 19.45,
      giniCoefficient: 0.6, governanceProposals: [], topHolders: [], recentLargeTrades: [],
      coordinationEdges: [], poolReserveA: 100_000_000, poolReserveB: 8_500_000_000,
      pegPrice: 1.0, reserveBalance: 3_000_000_000, initialReserveBalance: 3_000_000_000,
    },
    {
      tick: 1, tokenPrice: 0.10, priceHistory: [85, 0.10], totalSupply: 1_000_000_000,
      circulatingSupply: 1_000_000_000, stakedSupply: 50_000_000, stakingAPY: 19.45,
      giniCoefficient: 0.85, governanceProposals: [], topHolders: [
        { address: "WHALE_01", agentId: "WHALE_01", balance: 0 },
      ], recentLargeTrades: [
        { agentId: "WHALE_01", action: "sell", amount: 50_000_000 },
      ], coordinationEdges: [], poolReserveA: 1_000_000_000, poolReserveB: 100_000_000,
      pegPrice: 0.45, reserveBalance: 0, initialReserveBalance: 3_000_000_000,
    },
  ];
  for (const s of states) db.insertTickState(simId, s.tick, s, 100);
  const sellAction: AgentAction = {
    tick: 1, agentId: "WHALE_01", action: "sell", amount: 50_000_000,
    reasoning: "exit", threatAssessment: "peg break", txSignature: null,
    success: true, timestamp: Date.now(),
  };
  db.insertAction(simId, sellAction);
  const farmerUnstake: AgentAction = {
    tick: 1, agentId: "FARMER_01", action: "unstake", amount: 20_000_000,
    reasoning: "yield gone", threatAssessment: "reserve depleted", txSignature: null,
    success: true, timestamp: Date.now(),
  };
  db.insertAction(simId, farmerUnstake);
}

describe("generateReport", () => {
  it("computes deterministic resilience + falls back gracefully when LLM fails", async () => {
    const db = tmpDb();
    const simId = "test-sim";
    seed(db, simId);

    // LLM that returns garbage — generator must still produce a complete report.
    const llm = new MockProvider({ rawDecide: () => "I cannot comply." });

    const report = await generateReport({
      simId, config: baseConfig, agents, db, llm,
      deathSpiralDetected: true, deathSpiralAtTick: 1, finalStatus: "death_spiral",
    });

    // Death-spiral cap: resilience must be ≤ 15.
    expect(report.resilienceScore).toBeLessThanOrEqual(15);
    expect(report.resilienceGrade).toBe("F");
    expect(report.meta.totalTicks).toBe(2);
    expect(report.meta.deathSpiralDetected).toBe(true);
    expect(report.meta.minPeg).toBeLessThan(0.5);

    // Engine fallbacks must populate the structured fields the LLM didn't.
    expect(report.executiveSummary.length).toBeGreaterThan(20);
    expect(report.failureModes.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    // Heuristic comparison should fire for high-APY + algo-stable + spiral.
    expect(report.comparison?.collapseName).toContain("LUNA");

    // Agent rankings include both seeded agents.
    expect(report.agentRankings.length).toBe(2);
    db.close();
  });

  it("uses LLM JSON when the model returns a well-formed payload", async () => {
    const db = tmpDb();
    const simId = "test-sim-2";
    seed(db, simId);

    const llmJson = {
      executiveSummary: "LLM-authored exec summary that is long enough to clear the threshold.",
      failureModes: [{
        name: "Yield-driven reserve drain",
        detectedAtTick: 1,
        severity: 92,
        description: "The 19.45% APY ate the reserve in one tick.",
        responsibleAgents: ["FARMER_01"],
      }],
      attackVectors: [{
        label: "Whale-led capitulation",
        startTick: 0,
        endTick: 1,
        timeline: ["WHALE_01 dumps 50M LUNA", "Farmers chain-unstake"],
      }],
      agentCharacterizations: { WHALE_01: "First mover, exits on peg break." },
      recommendations: [{
        parameter: "staking.baseAPY",
        suggestedValue: "8",
        rationale: "Bring APY in line with fee revenue.",
      }],
      comparison: {
        collapseName: "Terra LUNA",
        similarityScore: 88,
        reasoning: "Same algo-stable + reserve drain + cascade pattern.",
      },
    };
    const llm = new MockProvider({ rawDecide: () => JSON.stringify(llmJson) });

    const report = await generateReport({
      simId, config: baseConfig, agents, db, llm,
      deathSpiralDetected: true, deathSpiralAtTick: 1, finalStatus: "death_spiral",
    });

    expect(report.executiveSummary).toContain("LLM-authored");
    expect(report.failureModes[0]?.name).toBe("Yield-driven reserve drain");
    expect(report.attackVectors[0]?.timeline.length).toBe(2);
    expect(report.recommendations[0]?.parameter).toBe("staking.baseAPY");
    expect(report.comparison?.similarityScore).toBe(88);
    // LLM-supplied characterization should land on the matching ranking entry.
    const whale = report.agentRankings.find((r) => r.agentId === "WHALE_01");
    expect(whale?.characterization).toContain("First mover");
    db.close();
  });
});
