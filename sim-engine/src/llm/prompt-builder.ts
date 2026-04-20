import type { AgentState, SimulationState } from "../types";

/**
 * Build the per-tick LLM prompt for an agent.
 * The prompt gives the agent its identity, market context, and constraints,
 * then asks for a JSON action decision.
 */
export function buildAgentPrompt(
  agent: AgentState,
  sim: SimulationState
): string {
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

  // Stablecoin-specific info (for LUNA backtest)
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

  return `You are ${agent.persona.name} in a live token economy simulation on Solana devnet.

YOUR IDENTITY AND GOALS:
${agent.persona.systemPrompt}

CURRENT MARKET STATE (Tick ${sim.tick}):
- Token price: $${priceNow.toFixed(4)} (was $${price5TicksAgo.toFixed(4)} five ticks ago)
- Price trend: ${trend}
- Your holdings: ${agent.holdings.token.toLocaleString()} tokens, ${agent.holdings.staked.toLocaleString()} staked, $${agent.holdings.usdc.toLocaleString()} USDC
- Staking APY: ${sim.stakingAPY.toFixed(2)}%${stakingWarning}
- Total staked: ${((sim.stakedSupply / sim.totalSupply) * 100).toFixed(1)}% of supply
- Wealth concentration (Gini): ${sim.giniCoefficient.toFixed(3)}${giniWarning}${stablecoinSection}${rewardsLine}${governanceLine}
- Recent large trades: ${recentTrades}

YOUR RECENT ACTIONS: ${myActions}
OTHER AGENTS RECENTLY: ${othersActions}

CONSTRAINTS:
- You can only sell/unstake what you hold
- Maximum buy limited by your USDC balance
- Token balance: ${agent.holdings.token.toLocaleString()}, USDC balance: $${agent.holdings.usdc.toLocaleString()}

DECISION GUIDANCE:
- Your persona's NUMERIC DECISION TRIGGERS are not optional — if any trigger condition is met above, ACT this tick.
- "hold" is the default only when NO trigger fires. Do not hold just because prior ticks held.
- When acting, set "amount" to a real positive number (tokens or USDC units), NOT null.
- If you decide to sell/unstake based on reserve or peg, say so explicitly in "reasoning" (e.g. "reserve down 12%, unstaking").

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "buy" | "sell" | "stake" | "unstake" | "propose" | "vote_yes" | "vote_no" | "hold" | "burn_stablecoin",
  "amount": <number, or for vote_yes/vote_no the proposal id (omit to vote on latest), null for hold>,
  "reasoning": "<1-2 sentence explanation; for 'propose' this becomes the proposal description>",
  "threat_assessment": "<what failure mode do you sense, if any>"
}`;
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
