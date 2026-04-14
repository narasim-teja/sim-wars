// ============================================================
// Core Simulation Types
// ============================================================

export interface SimulationConfig {
  token: {
    totalSupply: number;
    decimals: number;
    allocations: { name: string; percent: number; vestingMonths: number }[];
  };
  staking: {
    baseAPY: number;
    maxAPY: number;
    lockPeriodTicks: number;
    unstakePenaltyPercent: number;
  };
  amm: {
    initialLiquidity: number;
    initialPrice: number;
    feeTier: number;
  };
  governance: {
    proposalThresholdPercent: number;
    quorumPercent: number;
    votingPeriodTicks: number;
    timelockTicks: number;
  };
  stablecoin?: {
    enabled: boolean;
    targetPeg: number;
    mintBurnRatio: number;
    reserveAmount: number;
  };
}

// ============================================================
// Agent Types
// ============================================================

export type AgentType =
  | "whale"
  | "yield_farmer"
  | "retail_degen"
  | "governance_attacker"
  | "sybil"
  | "mev_bot"
  | "long_term_holder"
  | "arbitrageur"
  | "treasury"
  | "lp_provider"
  | "analyst"
  | "insider"
  | "panic_seller";

export interface AgentPersona {
  id: string;
  type: AgentType;
  name: string;
  systemPrompt: string;
  riskTolerance: number; // 0-1
  initialCapital: { token: number; usdc: number; stakedFraction?: number };
  goals: string[];
}

export interface AgentState {
  persona: AgentPersona;
  walletAddress: string;
  holdings: { token: number; staked: number; usdc: number };
  memory: AgentAction[];
  observedActions: AgentAction[];
}

// ============================================================
// Action Types
// ============================================================

export type ActionType =
  | "buy"
  | "sell"
  | "stake"
  | "unstake"
  | "vote_yes"
  | "vote_no"
  | "propose"
  | "hold"
  | "add_liquidity"
  | "remove_liquidity"
  | "mint_stablecoin"
  | "burn_stablecoin";

export interface AgentAction {
  tick: number;
  agentId: string;
  action: ActionType;
  amount: number | null;
  reasoning: string;
  threatAssessment: string;
  txSignature: string | null;
  success: boolean;
  timestamp: number;
}

export interface LLMResponse {
  action: ActionType;
  amount: number | null;
  reasoning: string;
  threat_assessment: string;
}

// ============================================================
// Simulation State
// ============================================================

export interface SimulationState {
  tick: number;
  tokenPrice: number;
  priceHistory: number[];
  totalSupply: number;
  circulatingSupply: number;
  stakedSupply: number;
  stakingAPY: number;
  giniCoefficient: number;
  governanceProposals: Proposal[];
  topHolders: { address: string; agentId: string; balance: number }[];
  recentLargeTrades: { agentId: string; action: string; amount: number }[];
  poolReserveA: number;
  poolReserveB: number;
  // LUNA-specific
  stablecoinSupply?: number;
  reserveBalance?: number;
  pegPrice?: number;
  initialReserveBalance?: number;
  reserveDrainedThisTick?: number;
  yieldPaidThisTick?: number;
  borrowerRevenueThisTick?: number;
  rewardsPaidThisTick?: number;
}

export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  votesFor: number;
  votesAgainst: number;
  status: "active" | "passed" | "failed" | "executed";
  tickCreated: number;
  tickExpires: number;
}

export interface TickResult {
  tick: number;
  actions: AgentAction[];
  stateAfter: SimulationState;
  duration_ms: number;
}

// ============================================================
// Tick Configuration
// ============================================================

export interface TickConfig {
  intervalMs: number;
  maxTicks: number;
}

// ============================================================
// Scenario Configuration
// ============================================================

export interface ScenarioModule {
  config: SimulationConfig;
  agents: AgentPersona[];
  tickConfig: TickConfig;
}
