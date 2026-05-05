import type { AgentState, SimulationState } from "../types";

/**
 * Per-tick activation policy — decides which agents reason via the LLM
 * this tick and which ones default to "hold".
 *
 * Why this matters at scale: at 1000+ agents the dominant cost is the
 * fan-out of LLM calls per tick. Real markets don't have all participants
 * acting every tick — most wallets sit dormant for hours. Skipping the
 * LLM call for dormant agents trades minor fidelity loss for a 3-5×
 * cost reduction (and the same factor of latency reduction).
 *
 * Three policies:
 *   - "all" (default): every agent acts every tick. Preserves the
 *     original behavior; nothing is sampled out.
 *   - "sampled": each agent rolls against `persona.activation` (default
 *     1.0). Below the roll, the agent emits a synthetic hold and skips
 *     the LLM call.
 *   - "volatility": same as sampled, but the activation probability is
 *     scaled by a market-volatility multiplier ∈ [1, ~3]. High volatility
 *     pushes everyone toward 1.0; quiet markets let dormant agents stay
 *     dormant. This keeps panic cascades realistic.
 *
 * The roll is seeded by `(simId, tick, agentId)` so the same sim with
 * the same policy and seed produces the same active set on every replay.
 */
export type ActivationPolicy = "all" | "sampled" | "volatility";

export function parseActivationPolicy(raw: string | undefined): ActivationPolicy {
  if (!raw) return "all";
  const lower = raw.toLowerCase();
  if (lower === "all" || lower === "sampled" || lower === "volatility") return lower;
  throw new Error(`SIM_ACTIVATION_POLICY: unknown value "${raw}" — expected "all" | "sampled" | "volatility"`);
}

/**
 * Decide which agents are active this tick.
 *
 * Returns the list of agents that should make an LLM call. Inactive
 * agents are not returned — the caller is responsible for emitting a
 * synthetic hold for them.
 *
 * @param agents     Full ordered agent list (the orchestrator's batch order).
 * @param sim        Current simulation state — used for volatility lookup.
 * @param policy     Activation policy.
 * @param simId      Per-sim seed for deterministic rolls.
 */
export function pickActiveAgents(
  agents: AgentState[],
  sim: SimulationState,
  policy: ActivationPolicy,
  simId: string,
): AgentState[] {
  if (policy === "all") return agents;

  const volMultiplier = policy === "volatility" ? volatilityMultiplier(sim) : 1.0;

  return agents.filter((agent) => {
    const baseActivation = agent.persona.activation ?? 1.0;
    if (baseActivation >= 1.0) return true;
    if (baseActivation <= 0.0) return false;
    const effective = Math.min(1.0, baseActivation * volMultiplier);
    const roll = deterministicRoll(simId, sim.tick, agent.persona.id);
    return roll < effective;
  });
}

/**
 * Map recent price-history volatility to a [1, 3] multiplier. Quiet markets
 * stay at 1× (no boost); a 30% swing in the last 10 ticks pushes toward 3×
 * (everyone wakes up). Panic cascades remain realistic because PANIC and
 * MEV archetypes — typically activation=1.0 anyway — never get filtered.
 */
function volatilityMultiplier(sim: SimulationState): number {
  const window = sim.priceHistory.slice(-10);
  if (window.length < 2) return 1.0;
  const min = Math.min(...window);
  const max = Math.max(...window);
  if (min <= 0) return 3.0; // collapsed market — wake everyone
  const swing = (max - min) / min;
  return clamp(1 + swing * 6.7, 1.0, 3.0); // 30% swing → ~3.0
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Cheap deterministic [0, 1) roll keyed on (simId, tick, agentId). Uses
 * FNV-1a then a Mulberry32-style finalizer; not cryptographic but stable
 * across processes and reproducible.
 */
function deterministicRoll(simId: string, tick: number, agentId: string): number {
  let h = 0x811c9dc5;
  const key = `${simId}|${tick}|${agentId}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = (h + 0x6d2b79f5) >>> 0;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}
