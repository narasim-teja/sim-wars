/**
 * SimulationConfig normalizer.
 *
 * Mirror of `frontend/lib/extraction/schema.ts` minus the Zod dependency.
 * Same defaults, same semantics, applied at API receive time so the worker
 * and deploy script see a fully-populated config — fixes the case where
 * `amm: {}` arrived from extraction and the report path read `undefined`
 * for `amm.initialPrice`.
 *
 * Sole entry point is `normalizeConfig(raw)`. If you change a default here,
 * change `frontend/lib/extraction/schema.ts` too.
 */
import type { SimulationConfig } from "../types";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface Range {
  min?: number;
  max?: number;
  intOnly?: boolean;
}

function num(v: unknown, fallback: number, range?: Range): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  let out = v;
  if (range?.min != null) out = Math.max(range.min, out);
  if (range?.max != null) out = Math.min(range.max, out);
  if (range?.intOnly) out = Math.floor(out);
  return out;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function obj<T>(v: unknown, fallback: T): T {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
}

const DEFAULT_ALLOCATIONS = [
  { name: "Reserve", percent: 8, vestingMonths: 0, cliffMonths: 0 },
  { name: "Team", percent: 10, vestingMonths: 48, cliffMonths: 12 },
  { name: "Community", percent: 30, vestingMonths: 0, cliffMonths: 0 },
  { name: "Ecosystem", percent: 52, vestingMonths: 0, cliffMonths: 0 },
];

export function normalizeConfig(raw: DeepPartial<SimulationConfig> | unknown): SimulationConfig {
  const r = obj<DeepPartial<SimulationConfig>>(raw, {});

  const tokenIn = obj<NonNullable<typeof r.token>>(r.token, {});
  const metaIn = obj<NonNullable<typeof r.metadata>>(r.metadata, {});
  const allocsIn = Array.isArray(tokenIn.allocations) && tokenIn.allocations.length > 0
    ? tokenIn.allocations
    : DEFAULT_ALLOCATIONS;
  const allocations = allocsIn.map((a) => {
    const ai = obj<Partial<typeof DEFAULT_ALLOCATIONS[0]>>(a, {});
    const vestingMonths = num(ai.vestingMonths, 0, { min: 0, intOnly: true });
    let cliffMonths = num(ai.cliffMonths, 0, { min: 0, intOnly: true });
    if (vestingMonths === 0) cliffMonths = 0;
    else if (cliffMonths > vestingMonths) cliffMonths = vestingMonths;
    return {
      name: str(ai.name, "Allocation"),
      percent: num(ai.percent, 0, { min: 0, max: 100 }),
      vestingMonths,
      cliffMonths,
    };
  });

  const stakingIn = obj<NonNullable<typeof r.staking>>(r.staking, {});
  const ammIn = obj<NonNullable<typeof r.amm>>(r.amm, {});
  const govIn = obj<NonNullable<typeof r.governance>>(r.governance, {});
  const stableIn = r.stablecoin && obj<NonNullable<typeof r.stablecoin>>(r.stablecoin, undefined as never);
  const veIn = r.veToken && obj<NonNullable<typeof r.veToken>>(r.veToken, undefined as never);

  const out: SimulationConfig = {
    metadata: {
      protocolName: str(metaIn.protocolName, ""),
      tokenSymbol: str(metaIn.tokenSymbol, "TOKEN").toUpperCase().slice(0, 16),
      quoteSymbol: str(metaIn.quoteSymbol, "USDC").toUpperCase().slice(0, 16),
      protocolKind: str(metaIn.protocolKind, ""),
    },
    token: {
      totalSupply: num(tokenIn.totalSupply, 1_000_000_000, { min: 1 }),
      decimals: num(tokenIn.decimals, 6, { min: 0, max: 18, intOnly: true }),
      allocations,
    },
    staking: {
      baseAPY: num(stakingIn.baseAPY, 10, { min: 0, max: 10_000 }),
      maxAPY: num(stakingIn.maxAPY, 20, { min: 0, max: 10_000 }),
      lockPeriodTicks: num(stakingIn.lockPeriodTicks, 0, { min: 0, intOnly: true }),
      unstakePenaltyPercent: num(stakingIn.unstakePenaltyPercent, 0, { min: 0, max: 100 }),
      unstakeCooldownTicks: num(stakingIn.unstakeCooldownTicks, 1, { min: 0, intOnly: true }),
      rewardEmissionRate: num(stakingIn.rewardEmissionRate, 0, { min: 0, max: 1 }),
    },
    amm: {
      initialLiquidity: num(ammIn.initialLiquidity, 100_000_000, { min: 1 }),
      initialPrice: num(ammIn.initialPrice, 1, { min: 0.000001 }),
      feeTier: num(ammIn.feeTier, 0.3, { min: 0, max: 100 }),
    },
    governance: {
      proposalThresholdPercent: num(govIn.proposalThresholdPercent, 0.1, { min: 0, max: 100 }),
      quorumPercent: num(govIn.quorumPercent, 10, { min: 0, max: 100 }),
      votingPeriodTicks: num(govIn.votingPeriodTicks, 5, { min: 0, intOnly: true }),
      timelockTicks: num(govIn.timelockTicks, 0, { min: 0, intOnly: true }),
    },
  };

  if (stableIn) {
    const riskIn = obj<NonNullable<NonNullable<typeof stableIn.riskModel>>>(stableIn.riskModel, {});
    out.stablecoin = {
      enabled: bool(stableIn.enabled, false),
      targetPeg: num(stableIn.targetPeg, 1, { min: 0.000001 }),
      mintBurnRatio: num(stableIn.mintBurnRatio, 1, { min: 0.000001 }),
      reserveAmount: num(stableIn.reserveAmount, 0, { min: 0 }),
      riskModel: {
        borrowerRevenueRatio: num(riskIn.borrowerRevenueRatio, 0.15, { min: 0, max: 1 }),
        redemptionThreshold: num(riskIn.redemptionThreshold, 0.98, { min: 0.000001 }),
        maxRedemptionPercentPerTick: num(riskIn.maxRedemptionPercentPerTick, 0.2, { min: 0, max: 1 }),
        redemptionRateMultiplier: num(riskIn.redemptionRateMultiplier, 0.5, { min: 0 }),
        sellPressureCoefficient: num(riskIn.sellPressureCoefficient, 0.4, { min: 0 }),
        reservePressureCoefficient: num(riskIn.reservePressureCoefficient, 0.3, { min: 0 }),
        momentumPressureCoefficient: num(riskIn.momentumPressureCoefficient, 0.3, { min: 0 }),
      },
    };
    const risk = out.stablecoin.riskModel!;
    risk.redemptionThreshold = Math.min(out.stablecoin.targetPeg, risk.redemptionThreshold ?? 0.98);
  }

  if (veIn) {
    out.veToken = {
      enabled: bool(veIn.enabled, false),
      maxLockMonths: num(veIn.maxLockMonths, 48, { min: 1, intOnly: true }),
      voteWeightCurve: veIn.voteWeightCurve === "constant" ? "constant" : "linear-decay",
      boostMultiplier: num(veIn.boostMultiplier, 2.5, { min: 0.000001 }),
    };
  }

  // Auto-rebalance allocations to sum to 100% — the on-chain program rejects
  // anything else, and we'd rather adjust here than 400 the request.
  const totalPct = out.token.allocations.reduce((s, a) => s + a.percent, 0);
  if (totalPct > 0 && Math.abs(totalPct - 100) > 0.001) {
    const scale = 100 / totalPct;
    for (const a of out.token.allocations) a.percent = a.percent * scale;
  }

  return out;
}
