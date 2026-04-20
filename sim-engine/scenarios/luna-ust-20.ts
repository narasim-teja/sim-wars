import type { SimulationConfig, AgentPersona, TickConfig } from "../src/types";
import { ALL_PHASE2_PERSONAS } from "../src/agents/personas";

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

export const agents: AgentPersona[] = ALL_PHASE2_PERSONAS;

export const tickConfig: TickConfig = {
  intervalMs: 5_000,
  maxTicks: 20,
};

export default { config, agents, tickConfig };
