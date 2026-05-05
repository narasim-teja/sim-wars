import { describe, expect, it } from "bun:test";
import { pickActiveAgents, parseActivationPolicy } from "./activation";
import type { AgentState, AgentPersona, SimulationState } from "../types";

function makeAgent(id: string, activation: number | undefined): AgentState {
  const persona: AgentPersona = {
    id,
    type: "whale",
    name: id,
    systemPrompt: "test",
    riskTolerance: 0.5,
    initialCapital: { token: 0, usdc: 0 },
    goals: [],
    activation,
  };
  return {
    persona,
    walletAddress: id,
    holdings: { token: 0, staked: 0, usdc: 0 },
    memory: [],
    observedActions: [],
  };
}

function makeSim(priceHistory: number[], tick = 1): SimulationState {
  return {
    tick,
    tokenPrice: priceHistory[priceHistory.length - 1] ?? 1,
    priceHistory,
    totalSupply: 1_000_000,
    circulatingSupply: 1_000_000,
    stakedSupply: 0,
    stakingAPY: 0,
    giniCoefficient: 0,
    governanceProposals: [],
    topHolders: [],
    recentLargeTrades: [],
    coordinationEdges: [],
    poolReserveA: 100,
    poolReserveB: 100,
  };
}

describe("activation policy", () => {
  it("policy=all returns every agent regardless of activation field", () => {
    const agents = [makeAgent("A", 0.0), makeAgent("B", undefined), makeAgent("C", 0.5)];
    const sim = makeSim([1.0]);
    expect(pickActiveAgents(agents, sim, "all", "sim-1").length).toBe(3);
  });

  it("policy=sampled honors activation=1.0 always-on, activation=0 always-off", () => {
    const agents = [
      makeAgent("ALWAYS", 1.0),
      makeAgent("DEFAULT", undefined), // undefined → 1.0
      makeAgent("NEVER", 0.0),
    ];
    const sim = makeSim([1.0]);
    const active = pickActiveAgents(agents, sim, "sampled", "sim-1").map((a) => a.persona.id);
    expect(active).toContain("ALWAYS");
    expect(active).toContain("DEFAULT");
    expect(active).not.toContain("NEVER");
  });

  it("policy=sampled is deterministic for the same (simId, tick, agentId)", () => {
    const agents = Array.from({ length: 50 }, (_, i) => makeAgent(`A${i}`, 0.5));
    const sim = makeSim([1.0]);
    const a1 = pickActiveAgents(agents, sim, "sampled", "sim-X").map((a) => a.persona.id);
    const a2 = pickActiveAgents(agents, sim, "sampled", "sim-X").map((a) => a.persona.id);
    expect(a1).toEqual(a2);
  });

  it("policy=sampled at activation=0.5 over 200 agents lands near 50% (statistical)", () => {
    const agents = Array.from({ length: 200 }, (_, i) => makeAgent(`A${i}`, 0.5));
    const sim = makeSim([1.0]);
    const active = pickActiveAgents(agents, sim, "sampled", "sim-stat").length;
    // wide tolerance — this is a deterministic hash, not a distribution test
    expect(active).toBeGreaterThanOrEqual(80);
    expect(active).toBeLessThanOrEqual(120);
  });

  it("policy=volatility wakes more agents during a crash than a quiet market", () => {
    const agents = Array.from({ length: 200 }, (_, i) => makeAgent(`A${i}`, 0.3));
    const quiet = makeSim([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    const crash = makeSim([1.0, 0.95, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15, 0.1]);
    const quietActive = pickActiveAgents(agents, quiet, "volatility", "sim-vol").length;
    const crashActive = pickActiveAgents(agents, crash, "volatility", "sim-vol").length;
    // Crash should activate at least 50% more agents than quiet
    expect(crashActive).toBeGreaterThan(quietActive * 1.5);
  });
});

describe("parseActivationPolicy", () => {
  it("defaults to all when env is undefined or empty", () => {
    expect(parseActivationPolicy(undefined)).toBe("all");
    expect(parseActivationPolicy("")).toBe("all");
  });

  it("accepts valid policies case-insensitively", () => {
    expect(parseActivationPolicy("sampled")).toBe("sampled");
    expect(parseActivationPolicy("VOLATILITY")).toBe("volatility");
    expect(parseActivationPolicy("All")).toBe("all");
  });

  it("throws on unknown values rather than silently defaulting", () => {
    expect(() => parseActivationPolicy("random")).toThrow();
  });
});
