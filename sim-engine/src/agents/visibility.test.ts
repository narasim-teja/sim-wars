import { describe, expect, it } from "bun:test";
import type { AgentAction, AgentPersona } from "../types";
import {
  resolveVisibility,
  computeObservableActions,
  orderAgentsForObservation,
  DEFAULT_VISIBILITY_RULES,
  DEFAULT_TARGET_RULES,
} from "./visibility";

function mkAction(tick: number, agentId: string, action: AgentAction["action"], amount: number): AgentAction {
  return {
    tick,
    agentId,
    action,
    amount,
    reasoning: "r",
    threatAssessment: "t",
    txSignature: null,
    success: true,
    timestamp: 0,
  };
}

describe("resolveVisibility", () => {
  it("gives the insider full same-tick visibility of treasury", () => {
    const action = mkAction(5, "TREASURY_01", "buy", 100);
    const { delay, fidelity, action: shaped } = resolveVisibility("INSIDER_01", action);
    expect(delay).toBe(0);
    expect(fidelity).toBe(1);
    expect(shaped.amount).toBe(100);
  });

  it("delays other agents' view of the analyst by 1 tick", () => {
    const action = mkAction(5, "ANALYST_01", "sell", 10);
    const { delay } = resolveVisibility("WHALE_01", action);
    expect(delay).toBe(1);
  });

  it("default (no rule match) is immediate and full fidelity", () => {
    const action = mkAction(5, "WHALE_01", "sell", 10);
    const { delay, fidelity } = resolveVisibility("DEGEN_01", action);
    expect(delay).toBe(0);
    expect(fidelity).toBe(1);
  });

  it("obscures amount when fidelity < 1", () => {
    const action = mkAction(5, "X", "sell", 123);
    const rules = [{ observer: "OBS", target: "X", delay: 0, fidelity: 0.2 }];
    const { action: shaped } = resolveVisibility("OBS", action, rules, {});
    expect(shaped.amount).toBeNull();
    expect(shaped.reasoning).toBe("[obscured]");
  });
});

describe("computeObservableActions", () => {
  it("drops self-observations and applies delay", () => {
    const actions = [
      mkAction(5, "ANALYST_01", "sell", 100), // delay 1 for everyone else
      mkAction(5, "WHALE_01", "sell", 50),
      mkAction(5, "DEGEN_01", "buy", 20),
    ];

    // At same tick=5, WHALE should not yet see ANALYST's sell (delay=1), but should see DEGEN's buy.
    const visibleToWhale = computeObservableActions("WHALE_01", actions, 5);
    const ids = visibleToWhale.map((a) => a.agentId).sort();
    expect(ids).toEqual(["DEGEN_01"]);

    // One tick later, ANALYST's action should now be visible.
    const nextTick = computeObservableActions("WHALE_01", actions, 6);
    const laterIds = nextTick.map((a) => a.agentId).sort();
    expect(laterIds).toEqual(["ANALYST_01", "DEGEN_01"]);
  });

  it("INSIDER sees TREASURY same tick", () => {
    const actions = [mkAction(3, "TREASURY_01", "buy", 1_000_000)];
    const visible = computeObservableActions("INSIDER_01", actions, 3);
    expect(visible.length).toBe(1);
    expect(visible[0].agentId).toBe("TREASURY_01");
    expect(visible[0].amount).toBe(1_000_000);
  });
});

describe("orderAgentsForObservation", () => {
  it("treasury before others, analyst last", () => {
    const personas: AgentPersona[] = [
      { id: "A", type: "analyst", name: "a", systemPrompt: "", riskTolerance: 0, initialCapital: { token: 0, usdc: 0 }, goals: [] },
      { id: "I", type: "insider", name: "i", systemPrompt: "", riskTolerance: 0, initialCapital: { token: 0, usdc: 0 }, goals: [] },
      { id: "T", type: "treasury", name: "t", systemPrompt: "", riskTolerance: 0, initialCapital: { token: 0, usdc: 0 }, goals: [] },
      { id: "W", type: "whale", name: "w", systemPrompt: "", riskTolerance: 0, initialCapital: { token: 0, usdc: 0 }, goals: [] },
    ];
    const ordered = orderAgentsForObservation(personas).map((p) => p.id);
    expect(ordered.indexOf("T")).toBeLessThan(ordered.indexOf("W"));
    expect(ordered.indexOf("W")).toBeLessThan(ordered.indexOf("I"));
    expect(ordered.indexOf("I")).toBeLessThan(ordered.indexOf("A"));
  });
});

describe("default rule constants", () => {
  it("DEFAULT_VISIBILITY_RULES contains insider↔treasury rule", () => {
    const insider = DEFAULT_VISIBILITY_RULES.find(
      (r) => r.observer === "INSIDER_01" && r.target === "TREASURY_01",
    );
    expect(insider).toBeDefined();
  });
  it("DEFAULT_TARGET_RULES delays ANALYST_01 by one tick", () => {
    expect(DEFAULT_TARGET_RULES["ANALYST_01"].delay).toBe(1);
  });
});
