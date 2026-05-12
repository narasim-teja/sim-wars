/**
 * Roster expansion — turns a target `agentCount` into a concrete
 * `AgentPersona[]` by cloning archetypes from `personas.ts` with small
 * deterministic perturbations.
 *
 * Why deterministic: a hand-written 100-persona file would rot fast and the
 * LLM-drafted alternative is non-reproducible. Cloning archetypes keeps the
 * behavior space narrow + debuggable while still letting users dial roster
 * size to match their cost/runtime budget.
 *
 * Why preset-shaped: different stress-tests need different ratios. Named
 * fixture aliases (`luna`, `crv`) stay for demo compatibility; custom runs
 * should prefer neutral profiles (`balanced`, `stress`, `lockup_resilience`).
 *
 * Power users can still pass an explicit `agents: AgentPersona[]` to
 * `POST /api/sim` and skip the expander entirely.
 */

import type { AgentPersona } from "../types";
import { ROSTER_PERTURBATION } from "../constants";
import {
  ALL_PHASE2_PERSONAS,
  JUPITER_PERSONAS,
} from "./personas";

export type RosterPreset = "luna" | "jupiter" | "balanced" | "stress" | "lockup_resilience";

/**
 * Ratios are normalized — the expander rounds + redistributes to hit `count`
 * exactly. Keys are persona ID prefixes (e.g. "WHALE" matches WHALE_01,
 * WHALE_02, …) which lets us reuse the existing system prompts unchanged.
 */
const RATIOS: Record<RosterPreset, Record<string, number>> = {
  // LUNA-style cascade: heavy on farmers + degens to drive the death spiral,
  // a few whales + governance attackers, a treasury defender.
  luna: {
    WHALE: 4,
    GOV: 2,
    SYBIL: 2,
    MEV: 2,
    FARMER: 8,
    DEGEN: 8,
    HOLDER: 4,
    ARB: 2,
    TREASURY: 1,
    LP: 2,
    ANALYST: 1,
    INSIDER: 1,
    PANIC: 3,
  },
  // Jupiter JUP: 50% of revenue → Litterbox programmatic buyback. Massive
  // Jupuary airdrop dumpers (DEGEN-heavy) provide the persistent supply
  // overhang that Litterbox + ASR farmers absorb over time. Market makers
  // (WHALE_02 archetype) provide two-sided liquidity that dampens swings.
  jupiter: {
    WHALE: 4,
    GOV: 2,
    HOLDER: 6,
    FARMER: 6,
    ARB: 3,
    TREASURY: 1,
    DEGEN: 6,
    ANALYST: 2,
  },
  // Generic stress-test: even-ish across archetypes, no scenario bias.
  balanced: {
    WHALE: 3,
    GOV: 2,
    SYBIL: 1,
    MEV: 1,
    FARMER: 3,
    DEGEN: 3,
    HOLDER: 3,
    ARB: 2,
    TREASURY: 1,
    LP: 1,
    ANALYST: 1,
    INSIDER: 1,
    PANIC: 1,
  },
  stress: {
    WHALE: 4,
    GOV: 3,
    SYBIL: 2,
    MEV: 2,
    FARMER: 5,
    DEGEN: 5,
    HOLDER: 2,
    ARB: 3,
    TREASURY: 1,
    LP: 2,
    ANALYST: 1,
    INSIDER: 1,
    PANIC: 2,
  },
  lockup_resilience: {
    WHALE: 3,
    GOV: 2,
    HOLDER: 8,
    FARMER: 6,
    ARB: 2,
    TREASURY: 1,
    DEGEN: 2,
    LP: 2,
    ANALYST: 1,
    INSIDER: 1,
  },
};

/** Mulberry32 — deterministic, fast, fine for parameter perturbation. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string — used to seed the RNG from simId. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface ExpandRosterArgs {
  count: number;
  preset?: RosterPreset;
  /** Used to seed perturbation. Same simId → same roster. */
  simId: string;
}

/**
 * Build an N-agent roster from the chosen preset. Pulls archetypes from
 * `personas.ts` (LUNA pool by default; marinade/jito presets use their own
 * persona arrays; cloning ratios live in this file).
 */
export function expandRoster(args: ExpandRosterArgs): AgentPersona[] {
  const { count, simId } = args;
  const preset: RosterPreset = args.preset ?? "balanced";
  if (count <= 0) throw new Error(`expandRoster: count must be > 0, got ${count}`);

  const archetypePool = preset === "luna"
    ? ALL_PHASE2_PERSONAS
    : preset === "jupiter"
      ? JUPITER_PERSONAS
      : GENERIC_PERSONAS;
  const archetypesByPrefix = groupByPrefix(archetypePool);
  const ratios = RATIOS[preset];

  // 1. Distribute `count` across prefixes proportional to ratios. Round down,
  //    then add the leftover one-by-one to the largest underrepresented prefix.
  const totalWeight = Object.values(ratios).reduce((s, w) => s + w, 0);
  const allocations: { prefix: string; n: number }[] = Object.entries(ratios).map(
    ([prefix, weight]) => ({
      prefix,
      n: Math.floor((weight / totalWeight) * count),
    }),
  );
  let assigned = allocations.reduce((s, a) => s + a.n, 0);
  // Distribute remainder by largest fractional part.
  const fractions = Object.entries(ratios).map(([prefix, weight]) => ({
    prefix,
    frac: ((weight / totalWeight) * count) - Math.floor((weight / totalWeight) * count),
  }));
  fractions.sort((a, b) => b.frac - a.frac);
  for (const { prefix } of fractions) {
    if (assigned >= count) break;
    const slot = allocations.find((a) => a.prefix === prefix);
    if (slot) {
      slot.n += 1;
      assigned += 1;
    }
  }

  // 2. Clone archetypes per allocation, dropping any prefix that has no
  //    archetype available in the chosen pool.
  const rng = makeRng(hashSeed(simId));
  const out: AgentPersona[] = [];
  for (const { prefix, n } of allocations) {
    if (n === 0) continue;
    const candidates = archetypesByPrefix[prefix];
    if (!candidates || candidates.length === 0) continue;
    for (let i = 0; i < n; i++) {
      const base = candidates[i % candidates.length]!;
      out.push(cloneWithPerturbation(base, prefix, i + 1, rng));
    }
  }

  return out;
}

function groupByPrefix(pool: AgentPersona[]): Record<string, AgentPersona[]> {
  const out: Record<string, AgentPersona[]> = {};
  for (const p of pool) {
    const prefix = p.id.split("_")[0]!;
    (out[prefix] ??= []).push(p);
  }
  return out;
}

function cloneWithPerturbation(
  base: AgentPersona,
  prefix: string,
  index: number,
  rng: () => number,
): AgentPersona {
  const cap = ROSTER_PERTURBATION.capitalRange;
  const risk = ROSTER_PERTURBATION.riskRange;
  // 1.0 ± cap and 0 ± risk, uniform.
  const capScale = 1 + (rng() * 2 - 1) * cap;
  const riskDelta = (rng() * 2 - 1) * risk;
  const id = `${prefix}_${String(index).padStart(2, "0")}`;
  return {
    ...base,
    id,
    // Keep type, name, system prompt — these are the "behavior" fields and
    // we want every clone of an archetype to behave like its parent.
    initialCapital: {
      token: Math.max(0, Math.round(base.initialCapital.token * capScale)),
      usdc: Math.max(0, Math.round(base.initialCapital.usdc * capScale)),
      stakedFraction: base.initialCapital.stakedFraction,
    },
    riskTolerance: clamp(base.riskTolerance + riskDelta, 0, 1),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Default per-tick LLM activation by archetype prefix. Used by the
 * "sampled" / "volatility" activation policies to skip dormant agents.
 *
 * Calibration intent:
 *   - Always-on (1.0): WHALE, GOV, MEV, PANIC — event-driven, must react
 *     to every market move so cascades stay realistic.
 *   - Frequent (0.6–0.8): ARB, INSIDER, ANALYST — react quickly but not
 *     literally every tick.
 *   - Periodic (0.3–0.4): FARMER, DEGEN, SYBIL — slower yield/momentum
 *     re-evaluation; volatility multiplier wakes them in crashes.
 *   - Rare (0.1–0.2): HOLDER, TREASURY, LP — long-horizon participants
 *     who rarely have an edge in any given tick.
 */
const DEFAULT_ACTIVATION: Record<string, number> = {
  WHALE: 1.0,
  GOV: 1.0,
  MEV: 1.0,
  PANIC: 1.0,
  ARB: 0.7,
  INSIDER: 0.7,
  ANALYST: 0.6,
  FARMER: 0.4,
  DEGEN: 0.4,
  SYBIL: 0.3,
  HOLDER: 0.15,
  TREASURY: 0.15,
  LP: 0.15,
};

const GENERIC_PERSONAS: AgentPersona[] = [
  generic("WHALE_01", "whale", "Capital Allocator", "reasoning", 0.35, { token: 20_000_000, usdc: 8_000_000, stakedFraction: 0.25 },
    "You manage a large position in the protocol token. Optimize exit value, liquidity, and governance influence using only the live market, staking, peg, and governance data in the prompt."),
  generic("GOV_01", "governance_attacker", "Governance Strategist", "reasoning", 0.7, { token: 8_000_000, usdc: 3_000_000, stakedFraction: 0.55 },
    "You seek governance advantage. Accumulate voting power, propose parameter changes when useful, and abandon the strategy if market stress makes voting power uneconomic."),
  generic("SYBIL_01", "sybil", "Distributed Wallet Cluster", "standard", 0.6, { token: 5_000_000, usdc: 1_500_000, stakedFraction: 0.25 },
    "You coordinate many small wallets. Amplify profitable market signals and exploit incentive designs that reward fragmented ownership."),
  generic("MEV_01", "mev_bot", "Flow Extractor", "reasoning", 0.55, { token: 3_000_000, usdc: 6_000_000, stakedFraction: 0 },
    "You trade around large visible flow. Front-run trends, fade overextensions, and avoid long-term exposure unless the immediate expected value is positive."),
  generic("FARMER_01", "yield_farmer", "Yield Optimizer", "fast", 0.5, { token: 7_000_000, usdc: 1_000_000, stakedFraction: 0.75 },
    "You chase risk-adjusted yield. Stake when APY compensates for lock, penalty, and price risk; unstake or stop compounding when yield looks subsidized or unstable."),
  generic("DEGEN_01", "retail_degen", "Momentum Trader", "fast", 0.7, { token: 2_500_000, usdc: 700_000, stakedFraction: 0.15 },
    "You react to price momentum and crowd behavior. Buy strength, sell sharp drawdowns, and follow visible social proof from other agents."),
  generic("HOLDER_01", "long_term_holder", "Long Horizon Holder", "standard", 0.2, { token: 6_000_000, usdc: 700_000, stakedFraction: 0.7 },
    "You prefer protocol survival over short-term trading. Stake core exposure, vote conservatively, and only reduce risk under severe structural deterioration."),
  generic("ARB_01", "arbitrageur", "Relative Value Trader", "standard", 0.35, { token: 2_000_000, usdc: 5_000_000, stakedFraction: 0 },
    "You exploit price dislocations against peg, initial price, and recent trend. Trade mechanically and stay liquid."),
  generic("TREASURY_01", "treasury", "Protocol Treasury", "standard", 0.15, { token: 4_000_000, usdc: 18_000_000, stakedFraction: 0.35 },
    "You defend protocol stability with reserves. Buy during justified stress, avoid wasteful defense when reserves are compromised, and never chase momentum."),
  generic("LP_01", "lp_provider", "Liquidity Provider", "standard", 0.35, { token: 4_000_000, usdc: 4_000_000, stakedFraction: 0.15 },
    "You balance fee income against impermanent loss and depeg risk. Reduce exposure when volatility overwhelms expected fees."),
  generic("ANALYST_01", "analyst", "Market Analyst", "reasoning", 0.3, { token: 1_500_000, usdc: 500_000, stakedFraction: 0.2 },
    "You publish visible market signals through your actions. Size trades for information impact when the protocol shows stress."),
  generic("INSIDER_01", "insider", "Informed Trader", "reasoning", 0.6, { token: 2_500_000, usdc: 3_000_000, stakedFraction: 0.25 },
    "You exploit early knowledge of treasury and governance behavior. Trade before public signals when expected value is clear."),
  generic("PANIC_01", "panic_seller", "Reactive Seller", "fast", 0.9, { token: 1_500_000, usdc: 300_000, stakedFraction: 0.25 },
    "You are highly loss-averse. Sell or unstake on negative price, peg, reserve, or large-trade signals; hold only when the market is quiet."),
];

function generic(
  id: AgentPersona["id"],
  type: AgentPersona["type"],
  name: string,
  complexity: NonNullable<AgentPersona["complexity"]>,
  riskTolerance: number,
  initialCapital: AgentPersona["initialCapital"],
  behavior: string,
): AgentPersona {
  const prefix = id.split("_")[0]!;
  return {
    id,
    type,
    name,
    complexity,
    riskTolerance,
    initialCapital,
    activation: DEFAULT_ACTIVATION[prefix] ?? 0.5,
    systemPrompt: `${behavior}

NUMERIC DECISION TRIGGERS:
- If token price falls more than 10% over the recent window, reduce risk unless your role explicitly stabilizes the system.
- If staking APY is high relative to visible protocol health, treat it as potentially subsidized and reassess.
- If a peg, reserve, lock, penalty, or governance proposal is present in the market state, incorporate it directly.
- Otherwise choose the action that best advances your role-specific goal.`,
    goals: [name, "Exploit or defend protocol incentives", "React to extracted mechanism data"],
  };
}
