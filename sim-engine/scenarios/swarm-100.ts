import type { SimulationConfig, TickConfig } from "../src/types";
import { expandRoster } from "../src/agents/roster";

/**
 * Swarm-100 scenario — first cache-lane validation at scale.
 *
 * Uses the LUNA token economics so the death-spiral signal is comparable
 * with the 8-persona LUNA backtest, but expands the roster to 100 agents
 * via the `balanced` preset. With ~12 archetype templates in the pool,
 * each archetype has ~8 clones — meaning the archetype zone of the prompt
 * is shared across 8 agents per cache lane. That's the structural win
 * Phase A's zoning was waiting for.
 *
 * Cost target: ~$0.08 for a 5-tick run with cacheMode=flat. Cache hit rate
 * should rise meaningfully above the 8.2% we saw in the 8-persona LUNA run.
 */
export const config: SimulationConfig = {
  token: {
    totalSupply: 1_000_000_000,
    decimals: 6,
    allocations: [
      { name: "LFG Reserve", percent: 8, vestingMonths: 0 },
      { name: "Team", percent: 10, vestingMonths: 48 },
      { name: "Community", percent: 30, vestingMonths: 0 },
      { name: "Ecosystem", percent: 52, vestingMonths: 0 },
    ],
  },
  staking: {
    baseAPY: 19.45,
    maxAPY: 19.45,
    lockPeriodTicks: 0,
    unstakePenaltyPercent: 0,
  },
  amm: {
    initialLiquidity: 100_000_000,
    initialPrice: 85,
    feeTier: 0.3,
  },
  governance: {
    proposalThresholdPercent: 0.1,
    quorumPercent: 10,
    votingPeriodTicks: 5,
    timelockTicks: 0,
  },
  stablecoin: {
    enabled: true,
    targetPeg: 1.0,
    mintBurnRatio: 1,
    reserveAmount: 3_000_000_000,
  },
};

// Fixed simId fixture so the roster is deterministic across runs.
export const agents = expandRoster({ count: 100, preset: "balanced", simId: "swarm-100-v1" });

export const tickConfig: TickConfig = {
  intervalMs: 5_000,
  maxTicks: 5,
};

export default { config, agents, tickConfig };
