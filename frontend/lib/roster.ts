/**
 * Client-side mirror of the backend roster expander's archetype ratios so the
 * UI can preview the breakdown for an arbitrary `agentCount` × `rosterPreset`
 * without hitting the API. Keep in sync with
 * `sim-engine/src/agents/roster.ts:RATIOS`.
 *
 * The backend is the source of truth — these numbers exist so the user can
 * see "100 agents = ~25 farmers, 12 whales, …" before they hit Deploy.
 */
import type { RosterPreset } from "./api";

/** Hard cap matching the backend `MAX_AGENTS` constant. */
export const MAX_AGENTS = 5000;

/**
 * On-chain cap. Mirrors the backend `MAX_ONCHAIN_AGENTS` constant. The
 * server returns 400 above this, so the UI clamps proactively when the
 * on-chain toggle is on.
 */
export const MAX_ONCHAIN_AGENTS = 50;

/** Default agent count used when launching a custom (extraction-driven) run. */
export const DEFAULT_AGENT_COUNT = 100;

/**
 * Suggested log-scale steps for the agent-count slider. Hits the
 * conventional sweet-spots (8 = LUNA-8 preset, 20 = LUNA-20, 100 = stress
 * test, 1000+ = OASIS-style swarm).
 */
export const AGENT_COUNT_STEPS = [1, 8, 20, 50, 100, 250, 500, 1000, 2500, 5000] as const;

const ARCHETYPE_LABELS: Record<string, string> = {
  WHALE: "whale",
  GOV: "governance attacker",
  SYBIL: "sybil",
  MEV: "MEV bot",
  FARMER: "yield farmer",
  DEGEN: "retail degen",
  HOLDER: "long-term holder",
  ARB: "arbitrageur",
  TREASURY: "treasury",
  LP: "LP provider",
  ANALYST: "analyst",
  INSIDER: "insider",
  PANIC: "panic seller",
};

const RATIOS: Record<RosterPreset, Record<string, number>> = {
  luna: {
    WHALE: 4, GOV: 2, SYBIL: 2, MEV: 2, FARMER: 8, DEGEN: 8,
    HOLDER: 4, ARB: 2, TREASURY: 1, LP: 2, ANALYST: 1, INSIDER: 1, PANIC: 3,
  },
  crv: {
    WHALE: 4, GOV: 2, HOLDER: 8, FARMER: 8, ARB: 2,
    TREASURY: 1, DEGEN: 2, LP: 1, ANALYST: 1, INSIDER: 1,
  },
  balanced: {
    WHALE: 3, GOV: 2, SYBIL: 1, MEV: 1, FARMER: 3, DEGEN: 3,
    HOLDER: 3, ARB: 2, TREASURY: 1, LP: 1, ANALYST: 1, INSIDER: 1, PANIC: 1,
  },
  stress: {
    WHALE: 4, GOV: 3, SYBIL: 2, MEV: 2, FARMER: 5, DEGEN: 5,
    HOLDER: 2, ARB: 3, TREASURY: 1, LP: 2, ANALYST: 1, INSIDER: 1, PANIC: 2,
  },
  lockup_resilience: {
    WHALE: 3, GOV: 2, HOLDER: 8, FARMER: 6, ARB: 2,
    TREASURY: 1, DEGEN: 2, LP: 2, ANALYST: 1, INSIDER: 1,
  },
};

/**
 * Same allocation algorithm the backend uses (Hamilton's method): integer
 * floor distribution then largest-fractional-remainder gets the leftover.
 * The output sums to exactly `count`.
 */
export interface RosterPreview {
  count: number;
  preset: RosterPreset;
  byArchetype: { prefix: string; label: string; count: number }[];
  totalArchetypes: number;
}

export function previewRoster(count: number, preset: RosterPreset): RosterPreview {
  const ratios = RATIOS[preset];
  const totalWeight = Object.values(ratios).reduce((s, w) => s + w, 0);
  const allocations = Object.entries(ratios).map(([prefix, weight]) => ({
    prefix,
    n: Math.floor((weight / totalWeight) * count),
    frac: ((weight / totalWeight) * count) - Math.floor((weight / totalWeight) * count),
  }));
  let assigned = allocations.reduce((s, a) => s + a.n, 0);
  const sortedByFrac = [...allocations].sort((a, b) => b.frac - a.frac);
  for (const slot of sortedByFrac) {
    if (assigned >= count) break;
    slot.n += 1;
    assigned += 1;
  }
  return {
    count,
    preset,
    totalArchetypes: allocations.filter((a) => a.n > 0).length,
    byArchetype: allocations
      .filter((a) => a.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((a) => ({
        prefix: a.prefix,
        label: ARCHETYPE_LABELS[a.prefix] ?? a.prefix.toLowerCase(),
        count: a.n,
      })),
  };
}

/**
 * Heuristic mapping from extraction's `protocolKind` to the most
 * apropos roster. Used to auto-select the preset right after extraction.
 */
export function rosterPresetFromProtocolKind(kind: string | undefined): RosterPreset {
  if (!kind) return "balanced";
  if (kind === "veToken") return "lockup_resilience";
  if (kind === "stablecoin_algo") return "stress";
  // memecoin / liquid_staking / amm_dex / lending / governance_token /
  // other → balanced is the safest bet.
  return "balanced";
}

export const ROSTER_PRESET_LABELS: Record<RosterPreset, { label: string; description: string }> = {
  luna: {
    label: "LUNA-style cascade",
    description: "Heavy on farmers + degens + panic sellers. Drives the death-spiral pattern fastest.",
  },
  crv: {
    label: "veToken / Curve",
    description: "Long-term holders + farmers, no panic. Best for testing lock-up resilience.",
  },
  balanced: {
    label: "Balanced stress test",
    description: "Even-ish across archetypes, no scenario bias. Use for novel tokenomics.",
  },
  stress: {
    label: "Generic stress test",
    description: "Adversarial but protocol-neutral. Best for custom stablecoins and new mechanisms.",
  },
  lockup_resilience: {
    label: "Lock-up resilience",
    description: "Long-term holders + farmers. Tests whether locks dampen exit cascades.",
  },
};
