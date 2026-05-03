import { describe, expect, test } from "bun:test";
import { buildDeploymentPlan } from "./deployment-plan";
import type { AgentPersona, SimulationConfig } from "../types";

const config: SimulationConfig = {
  metadata: { tokenSymbol: "abc token", quoteSymbol: "usd.c" },
  token: {
    totalSupply: 10_000_000,
    decimals: 18,
    allocations: [
      { name: "Team", percent: 40, vestingMonths: 48, cliffMonths: 12 },
      { name: "Liquidity", percent: 60, vestingMonths: 0 },
    ],
  },
  staking: { baseAPY: 10, maxAPY: 15, lockPeriodTicks: 0, unstakePenaltyPercent: 0, rewardEmissionRate: 0 },
  amm: { initialLiquidity: 100_000, initialPrice: 1, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
};

const agent: AgentPersona = {
  id: "A",
  type: "whale",
  name: "A",
  systemPrompt: "test",
  riskTolerance: 0.5,
  initialCapital: { token: 10_000, usdc: 10_000, stakedFraction: 0.5 },
  goals: [],
};

describe("buildDeploymentPlan", () => {
  test("sanitizes labels and warns for SPL decimal clamp", () => {
    const plan = buildDeploymentPlan({ config, agents: [agent], onChain: true });
    expect(plan.symbols).toEqual({ base: "ABCTOKEN", quote: "USDC" });
    expect(plan.liquidSeedAllocation).toBe("Liquidity");
    expect(plan.programs.staking).toBe(true);
    expect(plan.programs.governance).toBe(true);
    expect(plan.warnings.some((w) => w.includes("clamped"))).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  test("blocks all-vested on-chain deployment", () => {
    const plan = buildDeploymentPlan({
      config: {
        ...config,
        token: {
          ...config.token,
          allocations: [{ name: "All", percent: 100, vestingMonths: 48 }],
        },
      },
      agents: [agent],
      onChain: true,
    });
    expect(plan.blockers.join(" ")).toContain("liquid token allocation");
  });
});
