import { describe, expect, test } from "bun:test";
import { StablecoinMechanismController } from "./stablecoin-controller";
import type { SimulationConfig, SimulationState } from "../types";

const config: SimulationConfig = {
  metadata: { protocolName: "Neutral Stable", tokenSymbol: "NST", quoteSymbol: "USD", protocolKind: "stablecoin_algo" },
  token: { totalSupply: 1_000_000, decimals: 6, allocations: [{ name: "All", percent: 100, vestingMonths: 0 }] },
  staking: { baseAPY: 20, maxAPY: 20, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
  amm: { initialLiquidity: 100_000, initialPrice: 1, feeTier: 0.3 },
  governance: { proposalThresholdPercent: 1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
  stablecoin: {
    enabled: true,
    targetPeg: 1,
    mintBurnRatio: 1,
    reserveAmount: 1_000_000,
  },
};

function state(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    tick: 0,
    tokenPrice: 1,
    priceHistory: [1, 0.9, 0.8, 0.7, 0.6],
    totalSupply: 1_000_000,
    circulatingSupply: 900_000,
    stakedSupply: 500_000,
    stakingAPY: 20,
    giniCoefficient: 0.4,
    governanceProposals: [],
    topHolders: [],
    recentLargeTrades: [{ agentId: "A", action: "sell", amount: 100_000 }],
    coordinationEdges: [],
    poolReserveA: 100_000,
    poolReserveB: 100_000,
    ...overrides,
  };
}

describe("StablecoinMechanismController", () => {
  test("runs stablecoin mechanics without LUNA/UST naming", () => {
    const controller = new StablecoinMechanismController(config);
    const result = controller.processTick(state());
    expect(result.reserveBalance).toBeLessThan(result.initialReserve);
    expect(result.pegPrice).toBeLessThan(1);
    expect(result.baseMinted).toBeGreaterThan(0);
    expect(result.stablecoinSupply).toBeLessThan(100_000);
  });

  test("uses risk-model borrower revenue ratio", () => {
    const controller = new StablecoinMechanismController({
      ...config,
      stablecoin: {
        ...config.stablecoin!,
        riskModel: { borrowerRevenueRatio: 1 },
      },
    });
    const result = controller.processTick(state({ recentLargeTrades: [], priceHistory: [1, 1, 1, 1, 1] }));
    expect(result.reserveDrainedThisTick).toBe(0);
  });
});
