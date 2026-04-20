import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimDatabase } from "../db/database";
import { MockProvider } from "../llm/providers/mock-provider";
import { runSimulation } from "../worker/simulation";
import type { SimulationConfig, AgentPersona, TickConfig, LLMResponse } from "../types";

// Tiny config: total supply 1M → 0.1% threshold = 1,000 staked tokens required
// to propose. GOV_A holds 2,000 pre-staked → eligible.
const config: SimulationConfig = {
  token: { totalSupply: 1_000_000, decimals: 6, allocations: [{ name: "All", percent: 100, vestingMonths: 0 }] },
  staking: { baseAPY: 0, maxAPY: 0, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
  amm: { initialLiquidity: 100_000, initialPrice: 1.0, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 0.1, quorumPercent: 0.1, votingPeriodTicks: 2, timelockTicks: 0 },
};

const agents: AgentPersona[] = [
  {
    id: "GOV_A", type: "governance_attacker", name: "a", complexity: "reasoning",
    systemPrompt: "a", riskTolerance: 0.5,
    initialCapital: { token: 2_000, usdc: 0, stakedFraction: 1.0 },
    goals: [],
  },
  {
    id: "GOV_B", type: "governance_attacker", name: "b", complexity: "reasoning",
    systemPrompt: "b", riskTolerance: 0.5,
    initialCapital: { token: 2_000, usdc: 0, stakedFraction: 1.0 },
    goals: [],
  },
];

describe("governance routing in orchestrator", () => {
  it("creates a proposal, records a yes vote, and surfaces it in state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sim-wars-gov-"));
    const db = new SimDatabase(join(tmp, "sim.sqlite"));

    const proposeResp: LLMResponse = { action: "propose", amount: null, reasoning: "buyback_treasury_rule", threat_assessment: "none" };
    const voteYesResp: LLMResponse = { action: "vote_yes", amount: 0, reasoning: "support", threat_assessment: "none" };
    const holdResp: LLMResponse = { action: "hold", amount: null, reasoning: "wait", threat_assessment: "none" };

    // Tick 0 — both agents hold.
    // Tick 1 — GOV_A proposes. GOV_B votes yes on the latest active proposal.
    // Tick 2 — both hold while voting period elapses.
    // Tick 3 — readState's tallyExpiredProposals marks it passed.
    let tick = 0;
    const llm = new MockProvider({
      decide: ({ agentId }) => {
        if (tick === 1) {
          if (agentId === "GOV_A") return proposeResp;
          if (agentId === "GOV_B") return voteYesResp;
        }
        return holdResp;
      },
    });

    // Hook the simulation to advance `tick` alongside the worker's tick.
    const simId = crypto.randomUUID();
    const tickConfig: TickConfig = { intervalMs: 0, maxTicks: 4 };

    await runSimulation({
      simId,
      config,
      agents,
      tickConfig,
      llm,
      db,
      onTickStart: (t) => { tick = t; },
    });

    const govAHistory = db.getAgentHistory(simId, "GOV_A", 10);
    expect(govAHistory.some((a) => a.action === "propose")).toBe(true);

    const govBHistory = db.getAgentHistory(simId, "GOV_B", 10);
    expect(govBHistory.some((a) => a.action === "vote_yes")).toBe(true);

    // Read the final persisted tick state — the proposal should be present and eventually passed.
    const ticks = db.getTickStates(simId);
    const last = ticks[ticks.length - 1];
    expect(last.governanceProposals.length).toBe(1);
    const proposal = last.governanceProposals[0];
    expect(proposal.proposer).toBe("GOV_A");
    expect(proposal.votesFor).toBeGreaterThan(0);
    expect(["passed", "active"]).toContain(proposal.status);

    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
