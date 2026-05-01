import { describe, expect, test } from "bun:test";
import { StateManager } from "./state-manager";
import type { SimulationConfig } from "../types";

function baseConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    token: { totalSupply: 1_000_000, decimals: 6, allocations: [] },
    staking: { baseAPY: 10, maxAPY: 10, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
    amm: { initialLiquidity: 100_000, initialPrice: 1, feeTier: 0.3 },
    governance: { proposalThresholdPercent: 0.1, quorumPercent: 5, votingPeriodTicks: 5, timelockTicks: 0 },
    ...overrides,
  };
}

const veConfig = baseConfig({
  veToken: {
    enabled: true,
    maxLockMonths: 48,
    voteWeightCurve: "linear-decay",
    boostMultiplier: 2.5,
  },
});

async function advanceTo(sm: StateManager, tick: number): Promise<void> {
  await sm.readState(tick, new Map());
}

describe("StateManager — veToken locks", () => {
  test("non-veToken protocols allow immediate unstake", async () => {
    const sm = new StateManager(baseConfig());
    sm.stake("A", 1000);
    expect(sm.unstake("A", 500)).toBe(500);
  });

  test("veToken: stake without lockTicks does not lock (honors caller)", async () => {
    const sm = new StateManager(veConfig);
    sm.stake("A", 1000); // no lockTicks
    expect(sm.getUnlockTick("A")).toBeNull();
    expect(sm.unstake("A", 1000)).toBe(1000);
  });

  test("veToken: stake with lockTicks blocks unstake until expiry", async () => {
    const sm = new StateManager(veConfig);
    sm.stake("A", 1000, 48 * 30); // max lock
    expect(sm.getUnlockTick("A")).toBe(48 * 30);
    expect(sm.unstake("A", 500)).toBe(0); // locked

    await advanceTo(sm, 48 * 30 - 1);
    expect(sm.unstake("A", 500)).toBe(0); // still locked

    await advanceTo(sm, 48 * 30);
    expect(sm.unstake("A", 500)).toBe(500); // expired
  });

  test("veToken: longer subsequent lock extends, shorter does not shrink", async () => {
    const sm = new StateManager(veConfig);
    sm.stake("A", 100, 100); // unlock at 100
    expect(sm.getUnlockTick("A")).toBe(100);

    sm.stake("A", 100, 50); // shorter — must not shrink
    expect(sm.getUnlockTick("A")).toBe(100);

    sm.stake("A", 100, 200); // longer — extends
    expect(sm.getUnlockTick("A")).toBe(200);
  });

  test("veToken linear-decay vote weight scales with remaining lock", async () => {
    const sm = new StateManager(veConfig);
    const max = 48 * 30;
    sm.stake("A", 1000, max);

    // At tick 0, remaining = max → boost = 2.5 → weight = 2500
    expect(sm.getVoteWeight("A")).toBe(2500);

    // Halfway through: remaining = max/2 → boost = 1 + 1.5×0.5 = 1.75 → 1750
    await advanceTo(sm, max / 2);
    expect(sm.getVoteWeight("A")).toBeCloseTo(1750, 0);

    // Past expiry: remaining = 0 → falls back to raw stake (1000)
    await advanceTo(sm, max + 5);
    expect(sm.getVoteWeight("A")).toBe(1000);
  });

  test("veToken constant curve applies fixed boost while locked", async () => {
    const sm = new StateManager(
      baseConfig({
        veToken: {
          enabled: true,
          maxLockMonths: 12,
          voteWeightCurve: "constant",
          boostMultiplier: 2,
        },
      }),
    );
    sm.stake("B", 500, 12 * 30);
    expect(sm.getVoteWeight("B")).toBe(1000); // 500 × 2

    await advanceTo(sm, 12 * 30 - 1);
    expect(sm.getVoteWeight("B")).toBe(1000); // still boosted

    await advanceTo(sm, 12 * 30);
    expect(sm.getVoteWeight("B")).toBe(500); // expired → raw stake
  });

  test("non-veToken protocols return raw stake from getVoteWeight", () => {
    const sm = new StateManager(baseConfig());
    sm.stake("A", 999);
    expect(sm.getVoteWeight("A")).toBe(999);
  });
});
