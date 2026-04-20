import { describe, expect, it } from "bun:test";
import { InMemoryStore } from "./memory";
import type { AgentAction } from "../types";

function mk(tick: number, id: string): AgentAction {
  return {
    tick,
    agentId: id,
    action: "sell",
    amount: 100,
    reasoning: "r",
    threatAssessment: "t",
    txSignature: null,
    success: true,
    timestamp: 0,
  };
}

describe("InMemoryStore.recordObservation delay", () => {
  it("delivers delayed observations only after advanceTick reaches the visibility point", () => {
    const store = new InMemoryStore();
    const a = mk(5, "ANALYST_01");

    // Record with delay=1; observed at tick 5+1=6.
    store.recordObservation("WHALE_01", a, { delay: 1 });

    // Still tick 5 — not visible.
    store.advanceTick(5);
    expect(store.getRecentObservations("WHALE_01", 10).length).toBe(0);

    // Tick 6 — should now be visible.
    store.advanceTick(6);
    const obs = store.getRecentObservations("WHALE_01", 10);
    expect(obs.length).toBe(1);
    expect(obs[0].agentId).toBe("ANALYST_01");
  });

  it("immediate observations (no delay) land without calling advanceTick", () => {
    const store = new InMemoryStore();
    store.recordObservation("OBS", mk(1, "X"));
    expect(store.getRecentObservations("OBS", 10).length).toBe(1);
  });

  it("bounds the observation list to the store's limit", () => {
    const store = new InMemoryStore(20, 3); // observation limit = 3
    for (let i = 0; i < 5; i++) {
      store.recordObservation("OBS", mk(i, `X${i}`));
    }
    const obs = store.getRecentObservations("OBS", 10);
    expect(obs.length).toBe(3);
    // Oldest two dropped → should see X2, X3, X4 (chronological).
    expect(obs.map((a) => a.agentId)).toEqual(["X2", "X3", "X4"]);
  });
});
