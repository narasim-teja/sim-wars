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
  const stablecoinSection =
    sim.stablecoinSupply !== undefined
      ? `
- Stablecoin supply: ${sim.stablecoinSupply?.toLocaleString()} (peg: $${sim.pegPrice?.toFixed(4)})
- Reserve balance: $${sim.reserveBalance?.toLocaleString()}`
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
- Wealth concentration (Gini): ${sim.giniCoefficient.toFixed(3)}${giniWarning}${stablecoinSection}
- Recent large trades: ${recentTrades}

YOUR RECENT ACTIONS: ${myActions}
OTHER AGENTS RECENTLY: ${othersActions}

CONSTRAINTS:
- You can only sell/unstake what you hold
- Maximum buy limited by your USDC balance
- Token balance: ${agent.holdings.token.toLocaleString()}, USDC balance: $${agent.holdings.usdc.toLocaleString()}

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "buy" | "sell" | "stake" | "unstake" | "hold" | "burn_stablecoin",
  "amount": <number or null for hold>,
  "reasoning": "<1-2 sentence explanation of your decision>",
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
