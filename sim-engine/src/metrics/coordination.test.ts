import { describe, expect, it } from "bun:test";
import type { AgentAction } from "../types";
import { computeCoordinationEdges } from "./coordination";

function action(tick: number, id: string, a: AgentAction["action"], amount: number): AgentAction {
  return {
    tick,
    agentId: id,
    action: a,
    amount,
    reasoning: "r",
    threatAssessment: "t",
    txSignature: null,
    success: true,
    timestamp: 0,
  };
}

describe("computeCoordinationEdges", () => {
  it("flags two whales dumping the same tick", () => {
    const actions = [
      action(1, "WHALE_01", "sell", 1_000_000),
      action(1, "WHALE_02", "sell", 900_000),
      action(2, "WHALE_01", "sell", 800_000),
      action(2, "WHALE_02", "sell", 700_000),
    ];
    const edges = computeCoordinationEdges(actions, 2, {
      windowTicks: 5,
      largeAmountThreshold: 100_000,
      minCoOccurrences: 2,
    });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const first = edges[0];
    const pair = [first.a, first.b].sort();
    expect(pair).toEqual(["WHALE_01", "WHALE_02"]);
    expect(first.score).toBe(2);
  });

  it("does not flag opposite-side actions", () => {
    const actions = [
      action(1, "A", "sell", 1_000_000),
      action(1, "B", "buy", 1_000_000),
      action(2, "A", "sell", 1_000_000),
      action(2, "B", "buy", 1_000_000),
    ];
    const edges = computeCoordinationEdges(actions, 2, {
      windowTicks: 5,
      largeAmountThreshold: 100_000,
      minCoOccurrences: 2,
    });
    expect(edges.length).toBe(0);
  });

  it("counts governance collusion (vote_yes) without needing a large amount", () => {
    const actions = [
      action(1, "GOV_01", "vote_yes", 0),
      action(1, "GOV_02", "vote_yes", 0),
      action(2, "GOV_01", "vote_yes", 1),
      action(2, "GOV_02", "vote_yes", 1),
    ];
    const edges = computeCoordinationEdges(actions, 2, {
      windowTicks: 5,
      largeAmountThreshold: 1_000_000, // governance still counts despite threshold
      minCoOccurrences: 2,
    });
    expect(edges.length).toBe(1);
    expect([edges[0].a, edges[0].b].sort()).toEqual(["GOV_01", "GOV_02"]);
  });

  it("respects the sliding window — old co-actions fall off", () => {
    const actions = [
      action(0, "A", "sell", 1_000_000),
      action(0, "B", "sell", 1_000_000),
      action(1, "A", "sell", 1_000_000),
      action(1, "B", "sell", 1_000_000),
    ];
    // Window=2 covers only ticks 4..5, so nothing in the actions set qualifies.
    const edges = computeCoordinationEdges(actions, 5, {
      windowTicks: 2,
      largeAmountThreshold: 100_000,
      minCoOccurrences: 2,
    });
    expect(edges.length).toBe(0);
  });

  it("ignores failed actions", () => {
    const actions: AgentAction[] = [
      { ...action(1, "A", "sell", 1_000_000), success: false },
      { ...action(1, "B", "sell", 1_000_000), success: false },
      { ...action(2, "A", "sell", 1_000_000), success: false },
      { ...action(2, "B", "sell", 1_000_000), success: false },
    ];
    const edges = computeCoordinationEdges(actions, 2, {
      windowTicks: 5,
      largeAmountThreshold: 100_000,
      minCoOccurrences: 2,
    });
    expect(edges.length).toBe(0);
  });
});
