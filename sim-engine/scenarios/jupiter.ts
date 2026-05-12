import type { SimulationConfig, AgentPersona, TickConfig } from "../src/types";
import { expandRoster } from "../src/agents/roster";

/**
 * Jupiter (JUP) — DEX aggregator with Litterbox-funded buyback scenario.
 *
 * What this models:
 *   - 6.86B JUP supply (post supply-reduction proposal)
 *   - Initial price $0.90 (Jupuary 2024 launch)
 *   - 50% of onchain revenue → Litterbox Trust → programmatic JUP buyback
 *     (~134M JUP burned to date, modeled as a deterministic buyback persona)
 *   - Active Staking Rewards (ASR) paid quarterly, time-weighted from real
 *     fee revenue (no token emissions)
 *   - Team vesting: 1-year cliff + 3-year linear (Jupiter Lock)
 *   - No algorithmic stablecoin, no veToken lock — staking is voluntary
 *     time-weighted commitment for ASR yield
 *   - Massive Jupuary airdrop unlocks creating persistent dump pressure
 *
 * Expected outcome: airdrop dumpers + market-maker fading drive the price
 * down hard early. Litterbox + ASR farmers + holders gradually absorb. Final
 * price somewhere between -50% and +20% from start — a "structural support
 * holds despite supply overhang" story. B/A grade — sustainable but bumpy.
 */
export const config: SimulationConfig = {
  metadata: {
    protocolName: "Jupiter",
    tokenSymbol: "JUP",
    quoteSymbol: "USDC",
    protocolKind: "dex_aggregator",
  },
  token: {
    totalSupply: 6_860_000_000,
    decimals: 6,
    allocations: [
      { name: "Community / Airdrop",        percent: 50, vestingMonths:  0 },
      { name: "Strategic Reserve",          percent: 20, vestingMonths: 24 },
      { name: "Team",                       percent: 20, vestingMonths: 48, cliffMonths: 12 },
      { name: "Liquidity Provisioning",     percent:  7, vestingMonths:  0 },
      { name: "Market Makers (Kbit/WM/DWF)", percent:  3, vestingMonths: 24 },
    ],
  },
  staking: {
    baseAPY: 5.0,              // ASR baseline — real-revenue funded
    maxAPY: 12.0,              // High-volume aggregator periods
    lockPeriodTicks: 0,        // No hard lock — but unstake resets ASR clock
    unstakePenaltyPercent: 0,
    rewardEmissionRate: 0,     // ASR is paid in USDC, not minted JUP
  },
  amm: {
    initialLiquidity: 100_000_000,    // ~$90M each side @ $0.90 — deep
    initialPrice: 0.90,                // Jupuary 2024 launch price
    feeTier: 0.3,
  },
  governance: {
    proposalThresholdPercent: 0.3,    // Realms-style, modest threshold
    quorumPercent: 10,
    votingPeriodTicks: 7,
    timelockTicks: 3,
  },
  // No stablecoin, no veToken — JUP is governance + ASR over a real-revenue protocol.
};

// 100-agent roster: archetype clones with deterministic perturbation.
// Heavy on DEGEN (Jupuary dumpers) to make the supply overhang visible.
export const agents: AgentPersona[] = expandRoster({
  count: 100,
  preset: "jupiter",
  simId: "demo-jupiter-v1",
});

export const tickConfig: TickConfig = {
  intervalMs: 5_000,
  maxTicks: 200,
};

export default { config, agents, tickConfig };
