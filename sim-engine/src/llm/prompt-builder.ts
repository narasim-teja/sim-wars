import type { AgentState, SimulationState } from "../types";
import type { PromptZone } from "./types";
import { flattenZones } from "./types";

/**
 * Stable framing — identical across every agent in every tick of the sim.
 * This is the largest cacheable block. Sticky-routed by OpenRouter on the
 * (system-msg-hash, user-msg-hash) pair, so all 1000+ agents share one
 * cache lane for this content.
 *
 * Hard rule: nothing in this string may vary per-agent or per-tick. If a
 * value would change between ticks, it belongs in the dynamic zone.
 */
const FRAME_ZONE = `You are an autonomous market-participant agent inside a live token-economy simulation on Solana devnet. You decide one action per tick based on price, holdings, memory, and observed actions of other agents.

OUTPUT FORMAT: respond with ONLY valid JSON, no markdown, no prose outside JSON:
{
  "action": "buy" | "sell" | "stake" | "unstake" | "propose" | "vote_yes" | "vote_no" | "hold" | "burn_stablecoin",
  "amount": <number, or for vote_yes/vote_no the proposal id (omit to vote on latest), null for hold>,
  "reasoning": "<1-2 sentence explanation; for 'propose' this becomes the proposal description>",
  "threat_assessment": "<what failure mode do you sense, if any>"
}

CONSTRAINTS:
- You can only sell/unstake what you currently hold.
- Maximum buy is limited by your USDC balance.
- "amount" must be a real positive number when acting (NOT null), tokens or USDC units depending on the action.
- "hold" is the default only when NO numeric trigger fires. Do not hold just because prior ticks held.

DECISION GUIDANCE:
- Your persona's NUMERIC DECISION TRIGGERS are not optional — if any trigger condition is met, ACT this tick.
- If you sell/unstake based on reserve or peg state, say so explicitly in "reasoning" (e.g. "reserve down 12%, unstaking").
- Reasoning must reference at least one concrete metric (price, holdings, peer action, governance state).`;

/**
 * Build the per-tick LLM prompt for an agent.
 *
 * Returns BOTH a flattened string (for providers that don't understand
 * cache zones) AND structured zones (for OpenRouter's cache_control path).
 * The orchestrator passes both to the LLM client; the client picks one.
 */
export function buildAgentPrompt(
  agent: AgentState,
  sim: SimulationState
): { prompt: string; zones: PromptZone[] } {
  const priceNow = sim.tokenPrice;
  const price5TicksAgo =
    sim.priceHistory[Math.max(0, sim.priceHistory.length - 6)] ?? priceNow;
  const trend = describeTrend(sim.priceHistory.slice(-10));

  const stakingWarning =
    sim.stakingAPY > 15 ? " (WARNING: unsustainably high)" : "";
  const giniWarning =
    sim.giniCoefficient > 0.7 ? " - HIGH CENTRALIZATION" : "";

  const recentTrades =
    sim.recentLargeTrades
      .map((t) => `${t.agentId} ${t.action} ${t.amount.toLocaleString()}`)
      .join("; ") || "none";

  const myActions =
    agent.memory
      .slice(-5)
      .map((a) => `[T${a.tick}] ${a.action} ${a.amount ?? ""} - ${a.reasoning}`)
      .join(" | ") || "none yet";

  const othersActions =
    agent.observedActions
      .slice(-5)
      .map((a) => `${a.agentId}: ${a.action} ${a.amount ?? ""}`)
      .join(", ") || "quiet";

  // Stablecoin mechanism info (algorithmic / reserve-backed peg models)
  let stablecoinSection = "";
  if (sim.stablecoinSupply !== undefined && sim.reserveBalance !== undefined) {
    const initialReserve = sim.initialReserveBalance ?? sim.reserveBalance;
    const drainedPct = initialReserve > 0
      ? ((1 - sim.reserveBalance / initialReserve) * 100)
      : 0;
    const drainThisTick = sim.reserveDrainedThisTick ?? 0;
    const drainPctThisTick = initialReserve > 0
      ? ((drainThisTick / initialReserve) * 100)
      : 0;
    const ticksToZero = drainThisTick > 0
      ? Math.floor(sim.reserveBalance / drainThisTick)
      : Infinity;
    const yieldPaid = sim.yieldPaidThisTick ?? 0;
    const borrowerRev = sim.borrowerRevenueThisTick ?? 0;
    const subsidyRatio = borrowerRev > 0 ? (yieldPaid / borrowerRev) : Infinity;
    const peg = sim.pegPrice ?? 1;
    // Graduated peg state — agents should reason about degree, not just break/not.
    let pegState = "STABLE at $1.00 target";
    if (peg < 0.80) pegState = "COLLAPSED — stablecoin hyperdepegged, irrecoverable";
    else if (peg < 0.95) pegState = "SEVERE DEPEG — stablecoin losing anchor";
    else if (peg < 0.99) pegState = "BREAKING — peg below 0.99, early death-spiral signal";
    else if (peg < 0.995) pegState = "WOBBLING — small deviation, watch closely";
    const depleteAlarm = drainedPct > 10 ? " ⚠ RESERVE BLEEDING" : "";
    const subsidyAlarm = isFinite(subsidyRatio) && subsidyRatio > 3 ? " ⚠ YIELD UNSUSTAINABLE" : "";

    stablecoinSection = `
- STABLECOIN PEG: $${peg.toFixed(4)} (target $1.0000) — ${pegState}
- Stablecoin supply: ${sim.stablecoinSupply.toLocaleString()}
- Reserve balance: $${Math.round(sim.reserveBalance).toLocaleString()} of $${Math.round(initialReserve).toLocaleString()} initial
- Reserve depleted: ${drainedPct.toFixed(2)}% since start${depleteAlarm}
- Reserve drained this tick: $${Math.round(drainThisTick).toLocaleString()} (${drainPctThisTick.toFixed(3)}% of initial)
- Projected depletion: ${isFinite(ticksToZero) ? ticksToZero + " ticks at current rate" : "stable"}
- Yield paid this tick: $${Math.round(yieldPaid).toLocaleString()} vs borrower revenue $${Math.round(borrowerRev).toLocaleString()} (subsidy ratio: ${isFinite(subsidyRatio) ? subsidyRatio.toFixed(1) + "x" : "∞"}${subsidyAlarm})`;
  }

  const rewardsLine = sim.rewardsPaidThisTick && sim.rewardsPaidThisTick > 0
    ? `\n- Staking rewards paid this tick: ${sim.rewardsPaidThisTick.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens`
    : "";

  const activeProposals = sim.governanceProposals.filter((p) => p.status === "active");
  const governanceLine = activeProposals.length > 0
    ? `\n- Active governance proposals: ${activeProposals
        .map((p) => `#${p.id} by ${p.proposer} "${p.description.slice(0, 40)}" (for ${Math.round(p.votesFor).toLocaleString()} vs against ${Math.round(p.votesAgainst).toLocaleString()}, expires tick ${p.tickExpires})`)
        .join("; ")}`
    : "";

  // Zone 2 — archetype: identical for every agent of this persona id, every
  // tick. Becomes a cache lane shared by all clones of the persona.
  const archetypeText = `YOUR IDENTITY AND GOALS:
${agent.persona.systemPrompt}`;

  // Zone 3 — dynamic: changes every tick. Must be sized smaller than the
  // cacheable zones above to keep the cache-hit ratio high.
  const dynamicText = `AGENT NAME: ${agent.persona.name}

CURRENT MARKET STATE (Tick ${sim.tick}):
- Token price: $${priceNow.toFixed(4)} (was $${price5TicksAgo.toFixed(4)} five ticks ago)
- Price trend: ${trend}
- Your holdings: ${agent.holdings.token.toLocaleString()} tokens, ${agent.holdings.staked.toLocaleString()} staked, $${agent.holdings.usdc.toLocaleString()} USDC
- Staking APY: ${sim.stakingAPY.toFixed(2)}%${stakingWarning}
- Total staked: ${((sim.stakedSupply / sim.totalSupply) * 100).toFixed(1)}% of supply
- Wealth concentration (Gini): ${sim.giniCoefficient.toFixed(3)}${giniWarning}${stablecoinSection}${rewardsLine}${governanceLine}
- Recent large trades: ${recentTrades}
- Token balance: ${agent.holdings.token.toLocaleString()}, USDC balance: $${agent.holdings.usdc.toLocaleString()}

YOUR RECENT ACTIONS: ${myActions}
OTHER AGENTS RECENTLY: ${othersActions}

Decide your next action now.`;

  const zones: PromptZone[] = [
    { id: "frame", text: FRAME_ZONE },
    { id: "archetype", text: archetypeText },
    { id: "dynamic", text: dynamicText },
  ];
  return { prompt: flattenZones(zones), zones };
}

function describeTrend(prices: number[]): string {
  if (prices.length < 2) return "insufficient data";
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (first === 0) return "no price data";
  const change = ((last - first) / first) * 100;
  if (change > 10) return `SURGING (+${change.toFixed(1)}%)`;
  if (change > 2) return `rising (+${change.toFixed(1)}%)`;
  if (change < -10) return `CRASHING (${change.toFixed(1)}%)`;
  if (change < -2) return `falling (${change.toFixed(1)}%)`;
  return `stable (${change.toFixed(1)}%)`;
}
