import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimDatabase } from "../db/database";
import { MockProvider } from "../llm/providers/mock-provider";
import { StateManager } from "../tick/state-manager";
import type { ChainExecutor } from "../chain/action-executor";
import type { AgentPersona, SimulationConfig, LLMResponse } from "../types";
import { AgentOrchestrator } from "./orchestrator";

const config: SimulationConfig = {
  token: { totalSupply: 1_000_000, decimals: 6, allocations: [{ name: "All", percent: 100, vestingMonths: 0 }] },
  staking: { baseAPY: 0, maxAPY: 0, lockPeriodTicks: 0, unstakePenaltyPercent: 0, unstakeCooldownTicks: 1 },
  amm: { initialLiquidity: 100_000, initialPrice: 1, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
};

const agent: AgentPersona = {
  id: "FARMER_TEST",
  type: "yield_farmer",
  name: "Farmer",
  systemPrompt: "unstake when scripted",
  riskTolerance: 0.5,
  initialCapital: { token: 100, usdc: 10, stakedFraction: 1 },
  goals: [],
};

describe("AgentOrchestrator on-chain staking lifecycle", () => {
  test("unstake requests on-chain and completes after cooldown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sim-wars-orch-"));
    const db = new SimDatabase(join(tmp, "sim.sqlite"));
    const stateManager = new StateManager(config);
    const response: LLMResponse = {
      action: "unstake",
      amount: 50,
      reasoning: "cooldown test",
      threat_assessment: "none",
    };
    const llm = new MockProvider({ scripted: new Map([[agent.id, response]]) });

    const calls: string[] = [];
    const fakeChain = {
      hasStaking: () => true,
      hasAgent: () => true,
      getDeployment: () => ({ staking: { unstakeCooldownTicks: 1 } }),
      requestUnstake: async () => {
        calls.push("request");
        return { txSignature: "requestTx", amountAtoms: 50n };
      },
      completeUnstake: async () => {
        calls.push("complete");
        return { txSignature: "completeTx" };
      },
      getAgentBalances: async () => ({ base: 50, quote: 10, luna: 50, ust: 10 }),
    } as unknown as ChainExecutor;

    const orchestrator = new AgentOrchestrator(
      [agent],
      llm,
      stateManager,
      db,
      "staking-test",
      fakeChain,
    );

    const state0 = await stateManager.readState(0, orchestrator.getAgentBalances());
    const actions = await orchestrator.processTickBatch(state0, 1);
    expect(actions[0]?.success).toBe(true);
    expect(calls).toEqual(["request"]);
    expect(orchestrator.getAgentBalances().get(agent.id)?.staked).toBe(50);
    expect(orchestrator.getAgentBalances().get(agent.id)?.token).toBe(0);

    await orchestrator.settlePendingUnstakes(1);
    expect(calls).toEqual(["request", "complete"]);
    expect(orchestrator.getAgentBalances().get(agent.id)?.token).toBe(50);

    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
