import type { AgentAction } from "../types";

/**
 * Coordinated-attack detector. Counts how often pairs of agents take large
 * same-sided actions within a sliding tick window and surfaces the top pairs
 * so the frontend can render dashed red edges between colluding nodes.
 *
 * "Large" is caller-configurable — we default to `0.01 * totalSupply` to match
 * the orchestrator's `recentLargeTrades` threshold.
 */

export interface CoordinationEdge {
  a: string;
  b: string;
  score: number;
}

export interface CoordinationOptions {
  /** Sliding window length in ticks. Default 5. */
  windowTicks?: number;
  /** Minimum |amount| to count an action as "large". */
  largeAmountThreshold?: number;
  /** Minimum co-occurrence count before an edge surfaces. Default 2. */
  minCoOccurrences?: number;
}

/** Bucket trading/unstaking into "exit", staking/buying into "entry", governance stays its own side. */
function actionSide(action: AgentAction["action"]): "exit" | "entry" | "gov" | "other" {
  switch (action) {
    case "sell":
    case "unstake":
    case "burn_stablecoin":
      return "exit";
    case "buy":
    case "stake":
    case "mint_stablecoin":
    case "add_liquidity":
      return "entry";
    case "propose":
    case "vote_yes":
    case "vote_no":
      return "gov";
    default:
      return "other";
  }
}

/**
 * Core scorer: returns the pairs with the highest co-occurrence score.
 * Score increments by 1 for each tick where both agents took the same-side
 * large action. Gov actions always count (there is no "large" governance).
 */
export function computeCoordinationEdges(
  actions: AgentAction[],
  currentTick: number,
  opts: CoordinationOptions = {},
): CoordinationEdge[] {
  const window = opts.windowTicks ?? 5;
  const threshold = opts.largeAmountThreshold ?? 0;
  const minCo = opts.minCoOccurrences ?? 2;

  // Group actions by tick.
  const byTick = new Map<number, AgentAction[]>();
  const fromTick = Math.max(0, currentTick - window + 1);
  for (const a of actions) {
    if (a.tick < fromTick || a.tick > currentTick) continue;
    if (!a.success) continue;
    const side = actionSide(a.action);
    if (side === "other") continue;
    if (side !== "gov" && threshold > 0 && Math.abs(a.amount ?? 0) < threshold) continue;
    const list = byTick.get(a.tick) ?? [];
    list.push(a);
    byTick.set(a.tick, list);
  }

  // Count same-side co-occurrences per pair.
  const pairCounts = new Map<string, number>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

  for (const tickActions of byTick.values()) {
    const bySide = new Map<string, string[]>(); // side → agentIds (dedup per-tick)
    for (const a of tickActions) {
      const side = actionSide(a.action);
      const list = bySide.get(side) ?? [];
      if (!list.includes(a.agentId)) list.push(a.agentId);
      bySide.set(side, list);
    }
    for (const ids of bySide.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = pairKey(ids[i], ids[j]);
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const edges: CoordinationEdge[] = [];
  for (const [key, count] of pairCounts) {
    if (count < minCo) continue;
    const [a, b] = key.split("|");
    edges.push({ a, b, score: count });
  }

  edges.sort((x, y) => y.score - x.score);
  return edges;
}
