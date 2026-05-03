import type { AgentPersona, SimulationConfig } from "../types";

export interface DeploymentPlan {
  symbols: { base: string; quote: string };
  programs: { tokenMint: true; ammDex: true; staking: boolean; governance: boolean };
  blockers: string[];
  warnings: string[];
  liquidSeedAllocation: string | null;
  requiredBaseTokens: number;
}

export interface BuildDeploymentPlanArgs {
  config: SimulationConfig;
  agents?: AgentPersona[];
  onChain?: boolean;
  withStaking?: boolean;
  withGovernance?: boolean;
}

export function buildDeploymentPlan(args: BuildDeploymentPlanArgs): DeploymentPlan {
  const { config, agents = [] } = args;
  const withStaking = args.withStaking ?? !!args.onChain;
  const govCfg = config.governance;
  const withGovernance = args.withGovernance ?? (
    withStaking &&
    (govCfg?.proposalThresholdPercent ?? 0) > 0 &&
    (govCfg?.quorumPercent ?? 0) > 0
  );

  const symbols = {
    base: cleanSymbol(config.metadata?.tokenSymbol, "TOKEN"),
    quote: cleanSymbol(config.metadata?.quoteSymbol, "USDC"),
  };
  const blockers: string[] = [];
  const warnings: string[] = [];

  const allocations = config.token.allocations;
  const liquid = allocations.filter((a) => (a.vestingMonths ?? 0) === 0 && a.percent > 0);
  const seed = liquid.reduce<typeof liquid[number] | null>(
    (largest, a) => (!largest || a.percent > largest.percent ? a : largest),
    null,
  );
  if (!seed) {
    blockers.push("at least one liquid token allocation is required to seed AMM liquidity and agent funding");
  }

  const agentTokenSum = agents.reduce((s, a) => s + a.initialCapital.token, 0);
  const totalStakedExpected = agents.reduce(
    (s, a) => s + a.initialCapital.token * (a.initialCapital.stakedFraction ?? 0),
    0,
  );
  const rewardSeedTarget = withStaking ? Math.max(1_000_000, agentTokenSum * 0.10) : 0;
  const emissionRate = config.staking.rewardEmissionRate ?? 0;
  const inflationBudget = withStaking && emissionRate > 0
    ? Math.max(0, totalStakedExpected * emissionRate * 200)
    : 0;
  const requiredBaseTokens = config.amm.initialLiquidity + agentTokenSum + rewardSeedTarget + inflationBudget;

  if (seed) {
    const seedCap = config.token.totalSupply * (seed.percent / 100);
    if (requiredBaseTokens > seedCap) {
      blockers.push(
        `liquid allocation '${seed.name}' can fund ${Math.floor(seedCap).toLocaleString()} ${symbols.base}, ` +
          `but deployment needs ${Math.ceil(requiredBaseTokens).toLocaleString()} ${symbols.base}`,
      );
    }
  }

  if (config.token.decimals > 9) {
    warnings.push(`token decimals ${config.token.decimals} will be clamped to 9 for SPL-token simulation safety`);
  }
  if (withGovernance && !withStaking) {
    blockers.push("governance deployment requires staking deployment");
  }
  if (args.onChain && agents.length > 500 && !process.env.ANCHOR_PROVIDER_URL?.includes("127.0.0.1")) {
    warnings.push("large on-chain runs need a paid RPC; public devnet airdrops and ATA creation may rate-limit");
  }

  return {
    symbols,
    programs: { tokenMint: true, ammDex: true, staking: withStaking, governance: withGovernance },
    blockers,
    warnings,
    liquidSeedAllocation: seed?.name ?? null,
    requiredBaseTokens,
  };
}

function cleanSymbol(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_$-]/g, "");
  return (cleaned || fallback).slice(0, 16);
}
