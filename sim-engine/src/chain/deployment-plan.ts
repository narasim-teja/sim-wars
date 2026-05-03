import type { AgentPersona, SimulationConfig } from "../types";

/**
 * One row of "this program won't deploy and here's why" — surfaced to the UI
 * so users see *what* the run will and won't exercise *before* clicking Deploy.
 */
export interface SkippedProgram {
  program: "staking" | "governance";
  /** Human reason; shown verbatim in the UI tooltip / panel. */
  reason: string;
  /** Dotted config path the user can fill in to enable the program. */
  enableHint: string;
}

export interface DeploymentPlan {
  symbols: { base: string; quote: string };
  programs: { tokenMint: true; ammDex: true; staking: boolean; governance: boolean };
  /** Programs that *could* deploy but were intentionally skipped. */
  skipped: SkippedProgram[];
  blockers: string[];
  warnings: string[];
  liquidSeedAllocation: string | null;
  requiredBaseTokens: number;
}

export interface BuildDeploymentPlanArgs {
  config: SimulationConfig;
  agents?: AgentPersona[];
  onChain?: boolean;
  /**
   * Dotted paths the user grounded in the source OR explicitly edited in the
   * config form (e.g. ["staking.baseAPY", "governance.quorumPercent"]).
   * When provided, programs whose section never appears in this list are
   * skipped — we won't deploy a staking program for a UNI-style governance
   * token that has no staking schedule, even if the schema's defaults filled
   * the staking block. Omitted ⇒ legacy behavior (deploy everything `onChain`
   * implies).
   */
  extractedFields?: string[];
  /** Force-enable overrides — used by the deploy CLI flags. Bypass the gate. */
  withStaking?: boolean;
  withGovernance?: boolean;
}

const STAKING_PROGRAM_HINT = "staking.baseAPY (and other staking.* fields)";
const GOVERNANCE_PROGRAM_HINT = "governance.proposalThresholdPercent + governance.quorumPercent";

export function buildDeploymentPlan(args: BuildDeploymentPlanArgs): DeploymentPlan {
  const { config, agents = [], extractedFields } = args;
  const onChain = !!args.onChain;

  // Gating policy: a program deploys when EITHER
  //   (a) the user extracted/edited any field in its config block, OR
  //   (b) the caller forced it on via `withStaking` / `withGovernance` flags
  //       (the deploy CLI uses this for backward compat).
  // When `extractedFields` is undefined (legacy callers, presets), we fall
  // back to "deploy everything on-chain runs need" so the demo presets don't
  // regress.
  const skipped: SkippedProgram[] = [];

  const stakingExplicitlyExtracted = sectionExtracted(extractedFields, "staking");
  const governanceExtracted = sectionExtracted(extractedFields, "governance");

  let withStaking: boolean;
  if (args.withStaking !== undefined) {
    withStaking = args.withStaking && onChain;
  } else if (extractedFields !== undefined) {
    withStaking = onChain && stakingExplicitlyExtracted;
    if (onChain && !stakingExplicitlyExtracted) {
      skipped.push({
        program: "staking",
        reason: "no staking parameters were extracted from the source or edited in the config",
        enableHint: STAKING_PROGRAM_HINT,
      });
    }
  } else {
    // Legacy path — preset scenarios with no `extractedFields` get the old
    // "always deploy when on-chain" behavior.
    withStaking = onChain;
  }

  const govCfg = config.governance;
  const govThresholdsValid =
    (govCfg?.proposalThresholdPercent ?? 0) > 0 && (govCfg?.quorumPercent ?? 0) > 0;

  let withGovernance: boolean;
  if (args.withGovernance !== undefined) {
    withGovernance = args.withGovernance && withStaking;
  } else if (extractedFields !== undefined) {
    const gateExtracted = onChain && governanceExtracted && govThresholdsValid && withStaking;
    withGovernance = gateExtracted;
    if (onChain && !governanceExtracted) {
      skipped.push({
        program: "governance",
        reason: "no governance parameters were extracted from the source or edited in the config",
        enableHint: GOVERNANCE_PROGRAM_HINT,
      });
    } else if (onChain && governanceExtracted && !govThresholdsValid) {
      skipped.push({
        program: "governance",
        reason: `governance.proposalThresholdPercent=${govCfg?.proposalThresholdPercent ?? 0}, quorumPercent=${govCfg?.quorumPercent ?? 0} — both must be > 0`,
        enableHint: GOVERNANCE_PROGRAM_HINT,
      });
    } else if (onChain && governanceExtracted && govThresholdsValid && !withStaking) {
      skipped.push({
        program: "governance",
        reason: "governance program requires the staking program — enable staking first",
        enableHint: STAKING_PROGRAM_HINT,
      });
    }
  } else {
    // Legacy path — keep old behavior for presets.
    withGovernance = withStaking && govThresholdsValid;
  }

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
    skipped,
    blockers,
    warnings,
    liquidSeedAllocation: seed?.name ?? null,
    requiredBaseTokens,
  };
}

/**
 * True iff `extractedFields` contains *any* dotted path under the named
 * top-level config section. Robust to extra whitespace and duplicates.
 */
function sectionExtracted(extractedFields: string[] | undefined, section: string): boolean {
  if (!extractedFields) return false;
  const prefix = `${section}.`;
  for (const f of extractedFields) {
    if (typeof f !== "string") continue;
    const trimmed = f.trim();
    if (trimmed === section || trimmed.startsWith(prefix)) return true;
  }
  return false;
}

function cleanSymbol(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_$-]/g, "");
  return (cleaned || fallback).slice(0, 16);
}
