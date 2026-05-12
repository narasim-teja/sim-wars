import type { SimulationConfig, AgentPersona, TickConfig } from "../src/types";
import { expandRoster } from "../src/agents/roster";

/**
 * LUNA-UST death-spiral scenario.
 *
 * What this models:
 *   - Anchor's 19.45% APY paid from reserve, not real revenue
 *   - Algorithmic stablecoin (UST) backed by mint-burn arbitrage against LUNA
 *   - Zero stake lockup — instant unstake-then-sell loop
 *   - Weak governance (low quorum, no timelock)
 *   - $3B LFG reserve as the doomed last line of defense
 *
 * Expected outcome: peg cracks → arbitrage drains the reserve → mint-burn
 * inflates LUNA supply → price → 0. F grade, death spiral detected.
 */
export const config: SimulationConfig = {
  metadata: {
    protocolName: "Terra LUNA / UST",
    tokenSymbol: "LUNA",
    quoteSymbol: "USDC",
    protocolKind: "stablecoin_algo",
  },
  token: {
    totalSupply: 1_000_000_000,
    decimals: 6,
    allocations: [
      { name: "LFG Reserve", percent: 8, vestingMonths: 0 },
      { name: "Team", percent: 10, vestingMonths: 48, cliffMonths: 12 },
      { name: "Community", percent: 30, vestingMonths: 0 },
      { name: "Ecosystem", percent: 52, vestingMonths: 0 },
    ],
  },
  staking: {
    baseAPY: 19.45,            // Anchor Protocol — THE design flaw
    maxAPY: 19.45,             // Fixed rate, no dynamic adjustment
    lockPeriodTicks: 0,        // No lock — instant exit
    unstakePenaltyPercent: 0,
  },
  amm: {
    initialLiquidity: 100_000_000,
    initialPrice: 85,           // ~peak LUNA
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
    reserveAmount: 3_000_000_000,  // LFG $3B reserve
  },
};

// 100-agent roster: archetype clones with deterministic perturbation.
export const agents: AgentPersona[] = expandRoster({
  count: 100,
  preset: "luna",
  simId: "demo-luna-v3",
});

export const tickConfig: TickConfig = {
  intervalMs: 5_000,
  maxTicks: 200,
};

export default { config, agents, tickConfig };
