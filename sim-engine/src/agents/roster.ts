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
 * Why preset-shaped (`luna` / `crv` / `balanced`): different stress-tests
 * need different ratios. LUNA wants more farmers + degens to drive the
 * cascade; CRV wants more long-term holders to model lock-up resilience.
 *
 * Power users can still pass an explicit `agents: AgentPersona[]` to
 * `POST /api/sim` and skip the expander entirely.
 */

import type { AgentPersona } from "../types";
import { ROSTER_PERTURBATION } from "../constants";
import {
  ALL_PHASE2_PERSONAS,
  CRV_PERSONAS,
} from "./personas";

export type RosterPreset = "luna" | "crv" | "balanced";

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
  // Curve / veToken: heavy on holders + farmers (committed-lock behavior),
  // a couple of whales, no panic seller (locks neutralize them).
  crv: {
    WHALE: 4,
    GOV: 2,
    HOLDER: 8,
    FARMER: 8,
    ARB: 2,
    TREASURY: 1,
    DEGEN: 2,
    LP: 1,
    ANALYST: 1,
    INSIDER: 1,
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
 * `personas.ts` (LUNA pool by default; CRV preset uses CRV_PERSONAS for
 * parameters but cloning ratios live in this file).
 */
export function expandRoster(args: ExpandRosterArgs): AgentPersona[] {
  const { count, simId } = args;
  const preset: RosterPreset = args.preset ?? "luna";
  if (count <= 0) throw new Error(`expandRoster: count must be > 0, got ${count}`);

  const archetypePool = preset === "crv" ? CRV_PERSONAS : ALL_PHASE2_PERSONAS;
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
