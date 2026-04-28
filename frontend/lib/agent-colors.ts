import type { AgentType, ActionType } from "./types";

/**
 * Single source of truth for agent palette. The graph nodes, feed badges,
 * and pie slices all read from here so legends stay consistent.
 */
export const AGENT_COLORS: Record<AgentType | "unknown", string> = {
  whale: "#ef4444",                // red
  yield_farmer: "#22c55e",         // green
  retail_degen: "#fb923c",         // orange
  governance_attacker: "#a855f7",  // purple
  sybil: "#ec4899",                // pink
  mev_bot: "#facc15",              // yellow
  long_term_holder: "#3b82f6",     // blue
  arbitrageur: "#14b8a6",          // teal
  treasury: "#06b6d4",             // cyan
  lp_provider: "#84cc16",          // lime
  analyst: "#e879f9",              // fuchsia
  insider: "#f97316",              // dark-orange
  panic_seller: "#dc2626",         // dark-red
  unknown: "#71717a",              // zinc-500
};

export const AGENT_LABELS: Record<AgentType | "unknown", string> = {
  whale: "Whale",
  yield_farmer: "Yield Farmer",
  retail_degen: "Retail Degen",
  governance_attacker: "Gov Attacker",
  sybil: "Sybil",
  mev_bot: "MEV Bot",
  long_term_holder: "Long-Term Holder",
  arbitrageur: "Arbitrageur",
  treasury: "Treasury",
  lp_provider: "LP Provider",
  analyst: "Analyst",
  insider: "Insider",
  panic_seller: "Panic Seller",
  unknown: "Unknown",
};

export const ACTION_COLORS: Record<ActionType, string> = {
  buy: "#22c55e",
  sell: "#ef4444",
  stake: "#06b6d4",
  unstake: "#f97316",
  vote_yes: "#a855f7",
  vote_no: "#a855f7",
  propose: "#a855f7",
  hold: "#71717a",
  add_liquidity: "#84cc16",
  remove_liquidity: "#facc15",
  mint_stablecoin: "#22c55e",
  burn_stablecoin: "#ef4444",
};

/** Edge color for the agent graph: red = sell-side, green = buy-side, purple = governance, gray = other. */
export function edgeColor(action: ActionType): string {
  if (action === "sell" || action === "unstake" || action === "remove_liquidity" || action === "burn_stablecoin")
    return "#ef4444";
  if (action === "buy" || action === "stake" || action === "add_liquidity" || action === "mint_stablecoin")
    return "#22c55e";
  if (action === "vote_yes" || action === "vote_no" || action === "propose")
    return "#a855f7";
  return "#71717a";
}

/**
 * Best-effort agent type from agent id naming convention.
 * The worker doesn't ship persona metadata in events, so we infer.
 */
export function agentTypeFromId(id: string): AgentType | "unknown" {
  const head = id.split("_")[0];
  switch (head) {
    case "WHALE": return "whale";
    case "FARMER": return "yield_farmer";
    case "DEGEN": return "retail_degen";
    case "GOV": return "governance_attacker";
    case "SYBIL": return "sybil";
    case "MEV": return "mev_bot";
    case "HOLDER": return "long_term_holder";
    case "ARB": return "arbitrageur";
    case "TREASURY": return "treasury";
    case "LP": return "lp_provider";
    case "ANALYST": return "analyst";
    case "INSIDER": return "insider";
    case "PANIC": return "panic_seller";
    default: return "unknown";
  }
}
