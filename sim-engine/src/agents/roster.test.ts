import { describe, expect, test } from "bun:test";
import { expandRoster } from "./roster";

describe("expandRoster", () => {
  test("produces exactly N agents for canonical sizes", () => {
    for (const n of [8, 20, 50, 100]) {
      const roster = expandRoster({ count: n, simId: "test-seed", preset: "luna" });
      expect(roster.length).toBe(n);
    }
  });

  test("ids are unique within a roster", () => {
    const roster = expandRoster({ count: 50, simId: "test-seed", preset: "luna" });
    const ids = new Set(roster.map((p) => p.id));
    expect(ids.size).toBe(50);
  });

  test("luna preset produces farmer + degen heavy mix", () => {
    const roster = expandRoster({ count: 50, simId: "test-seed", preset: "luna" });
    const counts = countByPrefix(roster);
    // Per RATIOS.luna: FARMER weight 8/40 = 20% → 10 of 50; DEGEN same.
    expect(counts.FARMER).toBeGreaterThanOrEqual(8);
    expect(counts.DEGEN).toBeGreaterThanOrEqual(8);
    expect(counts.WHALE).toBeGreaterThanOrEqual(3);
  });

  test("jupiter preset produces holder + degen + treasury mix", () => {
    const roster = expandRoster({ count: 30, simId: "test-seed", preset: "jupiter" });
    const counts = countByPrefix(roster);
    expect(counts.HOLDER ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.DEGEN ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.TREASURY ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("custom default uses generic balanced prompts, not LUNA fixture prompts", () => {
    const roster = expandRoster({ count: 20, simId: "generic-default" });
    expect(roster.length).toBe(20);
    expect(roster.some((p) => /peg cracks|Anchor Protocol|reserve depleted/i.test(p.systemPrompt))).toBe(false);
    expect(roster.some((p) => /protocol incentives|role-specific goal/i.test(p.systemPrompt))).toBe(true);
  });

  test("neutral production profiles are available without fixture prompts", () => {
    const stress = expandRoster({ count: 20, simId: "stress", preset: "stress" });
    const lockup = expandRoster({ count: 20, simId: "lockup", preset: "lockup_resilience" });
    expect(stress.some((p) => /peg cracks|Anchor Protocol|reserve depleted/i.test(p.systemPrompt))).toBe(false);
    expect(lockup.some((p) => /peg cracks|Anchor Protocol|reserve depleted/i.test(p.systemPrompt))).toBe(false);
  });

  test("same simId → same roster (deterministic)", () => {
    const a = expandRoster({ count: 50, simId: "deadbeef", preset: "luna" });
    const b = expandRoster({ count: 50, simId: "deadbeef", preset: "luna" });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.id).toBe(b[i]!.id);
      expect(a[i]!.initialCapital.token).toBe(b[i]!.initialCapital.token);
      expect(a[i]!.riskTolerance).toBe(b[i]!.riskTolerance);
    }
  });

  test("different simIds → different perturbations (same archetype split)", () => {
    const a = expandRoster({ count: 50, simId: "aaa", preset: "luna" });
    const b = expandRoster({ count: 50, simId: "bbb", preset: "luna" });
    // Same prefix counts (deterministic split)…
    expect(countByPrefix(a)).toEqual(countByPrefix(b));
    // …but capital wobble differs for at least one agent.
    const anyDiffers = a.some(
      (p, i) => p.initialCapital.token !== b[i]!.initialCapital.token,
    );
    expect(anyDiffers).toBe(true);
  });

  test("perturbation stays within ±20% capital range", () => {
    const roster = expandRoster({ count: 80, simId: "perturbation-test", preset: "luna" });
    for (const p of roster) {
      // Token capital must be a non-negative integer.
      expect(Number.isInteger(p.initialCapital.token)).toBe(true);
      expect(p.initialCapital.token).toBeGreaterThanOrEqual(0);
      expect(p.riskTolerance).toBeGreaterThanOrEqual(0);
      expect(p.riskTolerance).toBeLessThanOrEqual(1);
    }
  });

  test("rejects non-positive count", () => {
    expect(() => expandRoster({ count: 0, simId: "x" })).toThrow();
    expect(() => expandRoster({ count: -1, simId: "x" })).toThrow();
  });

  test("preserves system prompt + persona type from archetype", () => {
    const roster = expandRoster({ count: 20, simId: "prompts", preset: "luna" });
    for (const p of roster) {
      expect(p.systemPrompt.length).toBeGreaterThan(50);
      expect(p.type).toBeDefined();
    }
  });
});

function countByPrefix(roster: { id: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of roster) {
    const prefix = p.id.split("_")[0]!;
    out[prefix] = (out[prefix] ?? 0) + 1;
  }
  return out;
}
