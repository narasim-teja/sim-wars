/**
 * End-to-end scenario validation. Drives both LUNA and Jupiter through a
 * single "rational mock" LLM that picks actions based on persona type +
 * market state, not on actual reasoning. Ensures the structural difference
 * between the two scenarios shows up in the report:
 *
 *   - LUNA:    high APY + algo-stable + zero lock → death spiral, F grade
 *   - Jupiter: real revenue + Litterbox buyback + no peg → no spiral, A/B
 */

import { describe, expect, it } from "bun:test";
import { runSimulation } from "../worker/simulation";
import { generateReport } from "./generator";
import { SimDatabase } from "../db/database";
import { MockProvider } from "../llm/providers/mock-provider";
import lunaScenario from "../../scenarios/luna";
import jupiterScenario from "../../scenarios/jupiter";
import type { LLMResponse, AgentPersona } from "../types";

interface MarketHints {
  tick: number;
  lastPrice: number | null;
  initialPrice: number | null;
  reservePct: number;
  peg: number;
}

/**
 * Picks an action by persona type. The LUNA path needs a self-igniting cascade
 * (whales sell early, farmers chain-react) so the death-spiral threshold trips
 * inside 25 ticks without depending on slow stablecoin reserve drain. The CRV
 * path stays calm — long locks mean farmers can't unstake
 * even when they want to, so any panic stops at "intent to sell" instead of
 * actual sell pressure.
 *
 * "tick" comes out of the prompt so we can stage the cascade across a few ticks.
 */
function rationalMock(persona: AgentPersona, hints: MarketHints): LLMResponse {
  const decay = (100 - hints.reservePct) / 100;
  const pegBreak = hints.peg < 0.99;
  const priceDropPct =
    hints.initialPrice && hints.lastPrice != null
      ? (hints.initialPrice - hints.lastPrice) / hints.initialPrice
      : 0;
  const t = persona.type;
  const cap = persona.initialCapital.token;
  const tick = hints.tick;

  // WHALE: large-stake holders ignite the cascade. Start dumping at tick 2.
  if (t === "whale") {
    if (tick >= 2 || decay > 0.02 || pegBreak || priceDropPct > 0.05) {
      return reply("sell", cap * 0.6, `whale exit (tick ${tick})`);
    }
    return reply("hold", null, "wait");
  }
  // YIELD FARMER: chase yield, but bail aggressively once *anything* moves.
  if (t === "yield_farmer") {
    if (priceDropPct > 0.05 || decay > 0.05 || pegBreak || tick >= 3) {
      return reply("sell", cap * 0.9, "farmer panic exit");
    }
    return reply("stake", cap * 0.4, "stake for APY");
  }
  // PANIC SELLER: dumps on any negative signal.
  if (t === "panic_seller") {
    if (priceDropPct > 0.02 || decay > 0.02 || tick >= 2) {
      return reply("sell", cap * 0.5, "panic");
    }
    return reply("hold", null, "");
  }
  // RETAIL DEGEN: late but cataclysmic.
  if (t === "retail_degen") {
    if (priceDropPct > 0.10) return reply("sell", cap * 0.6, "retail panic");
    return reply("hold", null, "watch");
  }
  // SYBIL / MEV / LP: amplify on price moves.
  if (t === "sybil" || t === "mev_bot" || t === "lp_provider") {
    if (priceDropPct > 0.05) return reply("sell", cap * 0.5, "amplify the dump");
    return reply("hold", null, "");
  }
  // GOVERNANCE ATTACKER, LONG-TERM HOLDER, TREASURY: stabilize / accumulate.
  if (t === "governance_attacker") return reply("stake", cap * 0.5, "build voting power");
  if (t === "long_term_holder" || t === "treasury") return reply("stake", cap * 0.4, "diamond hands");
  return reply("hold", null, "no_signal");
}

function reply(action: LLMResponse["action"], amount: number | null, reason: string): LLMResponse {
  return { action, amount, reasoning: reason, threat_assessment: "n/a" };
}

/**
 * MockProvider can't see prompts ahead of time, so we parse the numbers we
 * need out of the prompt the orchestrator built. The keys we look for match
 * `prompt-builder.ts`'s output.
 */
function parseHints(prompt: string, initialPrice: number): MarketHints {
  const tickMatch = prompt.match(/CURRENT MARKET STATE \(Tick (\d+)\)/);
  const priceMatch = prompt.match(/Token price: \$([\d.]+)/);
  const depletedMatch = prompt.match(/Reserve depleted: ([\d.]+)%/);
  const pegMatch = prompt.match(/STABLECOIN PEG: \$([\d.]+)/);
  return {
    tick: tickMatch ? Number(tickMatch[1]) : 0,
    lastPrice: priceMatch ? Number(priceMatch[1]) : null,
    initialPrice,
    reservePct: depletedMatch ? 100 - Number(depletedMatch[1]) : 100,
    peg: pegMatch ? Number(pegMatch[1]) : 1,
  };
}

function buildLLM(personas: AgentPersona[], initialPrice: number): MockProvider {
  const byId = new Map(personas.map((p) => [p.id, p]));
  return new MockProvider({
    decide: ({ agentId, prompt }) => {
      const persona = byId.get(agentId);
      if (!persona) return { action: "hold", amount: null, reasoning: "unknown_agent", threat_assessment: "n/a" };
      return rationalMock(persona, parseHints(prompt, initialPrice));
    },
  });
}

function tmpDb(): SimDatabase {
  return new SimDatabase(`/tmp/sim-wars-scenario-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("scenario reports — structural differentiation", () => {
  it("LUNA scenario death-spirals into an F grade", async () => {
    const simId = `luna-${Date.now()}`;
    const db = tmpDb();
    const llm = buildLLM(lunaScenario.agents, lunaScenario.config.amm.initialPrice);

    const summary = await runSimulation({
      simId,
      config: lunaScenario.config,
      agents: lunaScenario.agents,
      tickConfig: { intervalMs: 0, maxTicks: 25 },
      llm,
      db,
      onChain: false,
    });

    expect(summary.totalTicks).toBeGreaterThan(0);
    // The whole point: LUNA's design should cascade into a death spiral.
    expect(summary.deathSpiralDetected).toBe(true);
    expect(summary.finalPrice).toBeLessThan(summary.initialPrice * 0.01);

    const report = await generateReport({
      simId,
      config: lunaScenario.config,
      agents: lunaScenario.agents,
      db, llm,
      deathSpiralDetected: summary.deathSpiralDetected,
      deathSpiralAtTick: summary.deathSpiralAtTick,
      finalStatus: "death_spiral",
    });

    expect(report.resilienceGrade).toBe("F");
    expect(report.resilienceScore).toBeLessThanOrEqual(15);
    // Heuristic: high APY + algo-stable + spiral ⇒ LUNA comparison
    expect(report.comparison?.collapseName).toContain("LUNA");
    // At least the price-spiral failure mode must be flagged.
    expect(report.failureModes.length).toBeGreaterThan(0);
    expect(report.failureModes.some((m) => m.name.toLowerCase().includes("spiral"))).toBe(true);
    db.close();
  }, 30000);

  it("Jupiter scenario survives — no death spiral, high resilience", async () => {
    const simId = `jupiter-${Date.now()}`;
    const db = tmpDb();
    const llm = buildLLM(jupiterScenario.agents, jupiterScenario.config.amm.initialPrice);

    const summary = await runSimulation({
      simId,
      config: jupiterScenario.config,
      agents: jupiterScenario.agents,
      tickConfig: { intervalMs: 0, maxTicks: 25 },
      llm,
      db,
      onChain: false,
    });

    expect(summary.totalTicks).toBeGreaterThan(0);
    // The whole point: this scenario should NOT cascade.
    expect(summary.deathSpiralDetected).toBe(false);
    // Price may dip from airdrop dumpers; Litterbox + holders should keep
    // it above 30% of initial (airdrop unlock pressure is heavy).
    expect(summary.finalPrice).toBeGreaterThan(summary.initialPrice * 0.3);

    const report = await generateReport({
      simId,
      config: jupiterScenario.config,
      agents: jupiterScenario.agents,
      db, llm,
      deathSpiralDetected: summary.deathSpiralDetected,
      deathSpiralAtTick: summary.deathSpiralAtTick,
      finalStatus: "completed",
    });

    expect(["S", "A", "B"]).toContain(report.resilienceGrade);
    expect(report.resilienceScore).toBeGreaterThanOrEqual(40);
    db.close();
  }, 30000);
});
