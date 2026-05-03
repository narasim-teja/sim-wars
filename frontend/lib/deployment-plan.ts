/**
 * Client-side mirror of `sim-engine/src/chain/deployment-plan.ts` — used by
 * the launch page to show "what will deploy" the moment the user toggles
 * on-chain on, without waiting for a server round-trip.
 *
 * The backend re-runs the same logic at `POST /api/sim` and is still the
 * source of truth (the response carries the authoritative plan). This file
 * exists only so the picker is responsive and so users can fix gaps in the
 * config *before* spending the deploy fee.
 *
 * Keep in sync with the backend file. Tests live alongside the backend.
 */

import type { SimulationConfigParsed } from "./extraction/types";

export interface SkippedProgram {
  program: "staking" | "governance" | "stablecoin";
  reason: string;
  enableHint: string;
}

export interface DeploymentPlanPreview {
  symbols: { base: string; quote: string };
  programs: { tokenMint: true; ammDex: true; staking: boolean; governance: boolean };
  skipped: SkippedProgram[];
  blockers: string[];
  warnings: string[];
}

export interface BuildPlanArgs {
  config: SimulationConfigParsed;
  onChain: boolean;
  /** Union of paths the LLM grounded AND the user edited in the form. */
  extractedFields: string[];
}

const STAKING_HINT = "staking.baseAPY (and other staking.* fields)";
const GOV_HINT = "governance.proposalThresholdPercent + governance.quorumPercent";

export function previewDeploymentPlan(args: BuildPlanArgs): DeploymentPlanPreview {
  const { config, onChain, extractedFields } = args;
  const skipped: SkippedProgram[] = [];

  const stakingExtracted = sectionExtracted(extractedFields, "staking");
  const governanceExtracted = sectionExtracted(extractedFields, "governance");

  const withStaking = onChain && stakingExtracted;
  if (onChain && !stakingExtracted) {
    skipped.push({
      program: "staking",
      reason: "no staking parameters were extracted from the source or edited in the config",
      enableHint: STAKING_HINT,
    });
  }

  const govThresholdsValid =
    (config.governance?.proposalThresholdPercent ?? 0) > 0 &&
    (config.governance?.quorumPercent ?? 0) > 0;
  let withGovernance = false;
  if (onChain && governanceExtracted && govThresholdsValid && withStaking) {
    withGovernance = true;
  } else if (onChain && !governanceExtracted) {
    skipped.push({
      program: "governance",
      reason: "no governance parameters were extracted from the source or edited in the config",
      enableHint: GOV_HINT,
    });
  } else if (onChain && governanceExtracted && !govThresholdsValid) {
    skipped.push({
      program: "governance",
      reason: `governance.proposalThresholdPercent=${config.governance?.proposalThresholdPercent ?? 0}, quorumPercent=${config.governance?.quorumPercent ?? 0} — both must be > 0`,
      enableHint: GOV_HINT,
    });
  } else if (onChain && governanceExtracted && govThresholdsValid && !withStaking) {
    skipped.push({
      program: "governance",
      reason: "governance program requires the staking program — enable staking first",
      enableHint: STAKING_HINT,
    });
  }

  const symbols = {
    base: cleanSymbol(config.metadata?.tokenSymbol, "TOKEN"),
    quote: cleanSymbol(config.metadata?.quoteSymbol, "USDC"),
  };

  const blockers: string[] = [];
  const warnings: string[] = [];
  const liquid = (config.token.allocations ?? []).filter(
    (a) => (a.vestingMonths ?? 0) === 0 && a.percent > 0,
  );
  if (onChain && liquid.length === 0) {
    blockers.push("at least one liquid token allocation is required to seed AMM liquidity and agent funding");
  }
  if (config.token.decimals > 9) {
    warnings.push(`token decimals ${config.token.decimals} will be clamped to 9 for SPL-token simulation safety`);
  }

  return {
    symbols,
    programs: { tokenMint: true, ammDex: true, staking: withStaking, governance: withGovernance },
    skipped,
    blockers,
    warnings,
  };
}

function sectionExtracted(extractedFields: string[], section: string): boolean {
  const prefix = `${section}.`;
  for (const f of extractedFields) {
    if (typeof f !== "string") continue;
    const t = f.trim();
    if (t === section || t.startsWith(prefix)) return true;
  }
  return false;
}

function cleanSymbol(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_$-]/g, "");
  return (cleaned || fallback).slice(0, 16);
}

/** Pretty label used in chips/badges: "TOKEN MINT", "AMM DEX", etc. */
export const PROGRAM_LABELS: Record<keyof DeploymentPlanPreview["programs"], string> = {
  tokenMint: "Token mint",
  ammDex: "AMM DEX",
  staking: "Staking",
  governance: "Governance",
};
