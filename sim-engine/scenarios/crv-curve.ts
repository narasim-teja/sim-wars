import type { SimulationConfig, AgentPersona, TickConfig } from "../src/types";
import { CRV_PERSONAS } from "../src/agents/personas";

/**
 * Curve veCRV stress-test scenario.
 *
 * What this models:
 *   - 4-year mandatory lock (lockPeriodTicks=1460, ~1 tick/day) — the structural defense
 *   - Modest, sustainable APY (~6%) sourced from real swap fees, not subsidies
 *   - High proposal threshold + quorum — governance capture is expensive
 *   - No algorithmic stablecoin — no peg to break
 *
 * Expected outcome: price wobbles but does NOT death-spiral. The lock prevents
 * the immediate-unstake-then-sell loop. The remaining attack surface (gauge
 * weight games, bribe market) extracts measurable value but is rate-limited.
 */
export const config: SimulationConfig = {
  token: {
    totalSupply: 3_303_030_000, // CRV approximated
    decimals: 6,
    allocations: [
      { name: "Community LP",    percent: 62, vestingMonths: 0 },
      { name: "Shareholders",    percent: 30, vestingMonths: 48 },
      { name: "Employees",       percent:  3, vestingMonths: 24 },
      { name: "Reserve",         percent:  5, vestingMonths: 12 },
    ],
  },
  staking: {
    baseAPY: 6.0,            // Sustainable, fee-funded
    maxAPY: 12.0,
    lockPeriodTicks: 1460,   // 4-year max lock; engine treats as illiquid
    unstakePenaltyPercent: 0,
  },
  amm: {
    initialLiquidity: 150_000_000,
    initialPrice: 5.0,        // CRV mid-range historical
    feeTier: 0.04,            // Curve's typical low-fee tier
  },
  governance: {
    proposalThresholdPercent: 1.0,  // 1% of supply to propose — high bar
    quorumPercent: 30,              // 30% quorum, defender-friendly
    votingPeriodTicks: 7,
    timelockTicks: 3,
  },
  // No stablecoin — purely a governance + emissions token
};

export const agents: AgentPersona[] = CRV_PERSONAS;

export const tickConfig: TickConfig = {
  intervalMs: 5_000,
  maxTicks: 30,
};

export default { config, agents, tickConfig };
