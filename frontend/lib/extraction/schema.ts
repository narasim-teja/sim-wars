import { z } from "zod";

/**
 * Mirror of `SimulationConfig` from sim-engine/src/types.ts.
 *
 * Every field is `.default(...)` because the LLM returns a sparse object —
 * whatever it could ground in the source. Missing fields fall back to the
 * LUNA-20 baseline so the simulation still runs.
 *
 * If the engine's SimulationConfig changes, change this file too.
 */

const Allocation = z.object({
  name: z.string().min(1),
  percent: z.number().min(0).max(100),
  vestingMonths: z.number().int().min(0).default(0),
});

const Token = z.object({
  totalSupply: z.number().positive().default(1_000_000_000),
  decimals: z.number().int().min(0).max(18).default(6),
  allocations: z.array(Allocation).default([
    { name: "Reserve", percent: 8, vestingMonths: 0 },
    { name: "Team", percent: 10, vestingMonths: 48 },
    { name: "Community", percent: 30, vestingMonths: 0 },
    { name: "Ecosystem", percent: 52, vestingMonths: 0 },
  ]),
});

const Staking = z.object({
  baseAPY: z.number().min(0).max(10_000).default(10),
  maxAPY: z.number().min(0).max(10_000).default(20),
  lockPeriodTicks: z.number().int().min(0).default(0),
  unstakePenaltyPercent: z.number().min(0).max(100).default(0),
});

const Amm = z.object({
  initialLiquidity: z.number().positive().default(100_000_000),
  initialPrice: z.number().positive().default(1),
  feeTier: z.number().min(0).max(100).default(0.3),
});

const Governance = z.object({
  proposalThresholdPercent: z.number().min(0).max(100).default(0.1),
  quorumPercent: z.number().min(0).max(100).default(10),
  votingPeriodTicks: z.number().int().min(0).default(5),
  timelockTicks: z.number().int().min(0).default(0),
});

const Stablecoin = z
  .object({
    enabled: z.boolean().default(false),
    targetPeg: z.number().positive().default(1),
    mintBurnRatio: z.number().positive().default(1),
    reserveAmount: z.number().min(0).default(0),
  })
  .optional();

export const SimulationConfigSchema = z.object({
  token: Token.default({} as never),
  staking: Staking.default({} as never),
  amm: Amm.default({} as never),
  governance: Governance.default({} as never),
  stablecoin: Stablecoin,
});

export type SimulationConfigParsed = z.infer<typeof SimulationConfigSchema>;

/**
 * What we ask the LLM to return: a deeply-partial version of the config plus
 * a few non-config hints. The shape is permissive so a model that only finds
 * supply + initial price still returns valid JSON.
 */
export const ExtractionResponseSchema = z.object({
  config: z.unknown(),
  notes: z.string().optional(),
  protocolName: z.string().optional(),
  protocolKind: z
    .enum([
      "stablecoin_algo",
      "liquid_staking",
      "lending",
      "amm_dex",
      "governance_token",
      "veToken",
      "memecoin",
      "other",
    ])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

/**
 * Walk the parsed config and produce a flat list of dotted field paths that
 * the LLM populated (i.e. were present and non-default). Used by the UI to
 * mark fields as `extracted` vs `default`.
 */
export function extractedFieldPaths(raw: unknown): string[] {
  const paths: string[] = [];
  walk(raw, "", paths);
  return paths;
}

function walk(node: unknown, prefix: string, out: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") {
    if (prefix) out.push(prefix);
    return;
  }
  if (Array.isArray(node)) {
    if (prefix) out.push(prefix);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    walk(v, next, out);
  }
}

/**
 * Coerce the LLM's raw config (deep partial, possibly with strings where
 * numbers belong) into a fully-populated, validated SimulationConfig.
 *
 * Returns the parsed config plus the paths that were actually present in the
 * input — the UI uses those to badge fields as "extracted".
 */
export function parseExtractedConfig(raw: unknown): {
  config: SimulationConfigParsed;
  extractedFields: string[];
} {
  const extractedFields = extractedFieldPaths(raw);
  const config = SimulationConfigSchema.parse(raw ?? {});
  return { config, extractedFields };
}
