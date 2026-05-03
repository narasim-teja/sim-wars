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
  test("sanitizes labels and warns for SPL decimal clamp (legacy path, no extractedFields)", () => {
    const plan = buildDeploymentPlan({ config, agents: [agent], onChain: true });
    expect(plan.symbols).toEqual({ base: "ABCTOKEN", quote: "USDC" });
    expect(plan.liquidSeedAllocation).toBe("Liquidity");
    expect(plan.programs.staking).toBe(true);
    expect(plan.programs.governance).toBe(true);
    expect(plan.skipped).toEqual([]);
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

  test("skips staking + governance when extractedFields names neither section", () => {
    const plan = buildDeploymentPlan({
      config,
      agents: [agent],
      onChain: true,
      extractedFields: ["token.totalSupply", "token.allocations", "amm.initialPrice"],
    });
    expect(plan.programs.staking).toBe(false);
    expect(plan.programs.governance).toBe(false);
    const skipped = plan.skipped.map((s) => s.program).sort();
    expect(skipped).toEqual(["governance", "staking"]);
  });

  test("deploys governance only when its fields were extracted AND staking is on", () => {
    // Governance extracted but staking not → governance is also skipped
    // (with the dependency-on-staking reason).
    const plan = buildDeploymentPlan({
      config,
      agents: [agent],
      onChain: true,
      extractedFields: ["governance.proposalThresholdPercent", "governance.quorumPercent"],
    });
    expect(plan.programs.staking).toBe(false);
    expect(plan.programs.governance).toBe(false);
    const govSkip = plan.skipped.find((s) => s.program === "governance");
    expect(govSkip?.reason).toContain("staking");
  });

  test("deploys staking + governance when both sections extracted", () => {
    const plan = buildDeploymentPlan({
      config,
      agents: [agent],
      onChain: true,
      extractedFields: [
        "staking.baseAPY",
        "governance.proposalThresholdPercent",
        "governance.quorumPercent",
      ],
    });
    expect(plan.programs.staking).toBe(true);
    expect(plan.programs.governance).toBe(true);
    expect(plan.skipped).toEqual([]);
  });

  test("withStaking flag overrides extractedFields gating (legacy CLI path)", () => {
    const plan = buildDeploymentPlan({
      config,
      agents: [agent],
      onChain: true,
      extractedFields: ["token.totalSupply"], // staking NOT extracted
      withStaking: true,
      withGovernance: true,
    });
    expect(plan.programs.staking).toBe(true);
    expect(plan.programs.governance).toBe(true);
  });

  test("off-chain run never deploys programs and emits no skipped entries", () => {
    const plan = buildDeploymentPlan({
      config,
      agents: [agent],
      onChain: false,
      extractedFields: ["token.totalSupply"],
    });
    expect(plan.programs.staking).toBe(false);
    expect(plan.programs.governance).toBe(false);
    expect(plan.skipped).toEqual([]);
  });

  test("skips governance when thresholds extracted but values are zero", () => {
    const plan = buildDeploymentPlan({
      config: {
        ...config,
        governance: { ...config.governance, proposalThresholdPercent: 0, quorumPercent: 0 },
      },
      agents: [agent],
      onChain: true,
      extractedFields: ["staking.baseAPY", "governance.proposalThresholdPercent"],
    });
    expect(plan.programs.governance).toBe(false);
    const govSkip = plan.skipped.find((s) => s.program === "governance");
    expect(govSkip?.reason).toContain("> 0");
  });
});
