import type { SimulationConfig, AgentPersona, TickConfig } from "../src/types";
import { LUNA_PERSONAS } from "../src/agents/personas";

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
    baseAPY: 19.45, // Anchor Protocol rate — THE design flaw
    maxAPY: 19.45, // Fixed rate (no dynamic adjustment)
    lockPeriodTicks: 0, // No lock period (another flaw)
    unstakePenaltyPercent: 0, // No unstaking penalty
  },
  amm: {
    initialLiquidity: 100_000_000,
    initialPrice: 85, // ~peak LUNA price
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
    reserveAmount: 3_000_000_000, // LFG $3B reserve
  },
};

export const agents: AgentPersona[] = LUNA_PERSONAS;

export const tickConfig: TickConfig = {
  intervalMs: 5_000, // 5s per tick for faster dev iteration
  maxTicks: 50,
};

export default { config, agents, tickConfig };
