// Mirror of sim-engine/src/types.ts and sim-engine/src/ipc/event-writer.ts
// Kept in sync manually — change in lockstep when the worker types change.

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

export interface AgentPersona {
  id: string;
  type: AgentType;
  name: string;
  systemPrompt: string;
  riskTolerance: number;
  initialCapital: { token: number; usdc: number; stakedFraction?: number };
  goals: string[];
  complexity?: "fast" | "standard" | "reasoning";
}

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
  coordinationEdges: { a: string; b: string; score: number }[];
  poolReserveA: number;
  poolReserveB: number;
  stablecoinSupply?: number;
  reserveBalance?: number;
  pegPrice?: number;
  initialReserveBalance?: number;
  reserveDrainedThisTick?: number;
  yieldPaidThisTick?: number;
  borrowerRevenueThisTick?: number;
  rewardsPaidThisTick?: number;
}

export type SimStatus =
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "death_spiral"
  | "interrupted";

export interface LLMUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export type WorkerEvent =
  | { kind: "sim:start"; ts: number; simId: string; agentCount: number; maxTicks: number }
  | { kind: "tick:start"; ts: number; tick: number }
  | {
      kind: "tick:complete";
      ts: number;
      tick: number;
      duration_ms: number;
      state: SimulationState;
      actions: AgentAction[];
      llmUsage?: LLMUsage;
    }
  | { kind: "agent:action"; ts: number; tick: number; action: AgentAction }
  | {
      kind: "sim:complete";
      ts: number;
      simId: string;
      status: SimStatus;
      totalTicks: number;
      llmUsage?: LLMUsage;
    }
  | { kind: "sim:death_spiral"; ts: number; simId: string; tick: number }
  | { kind: "report:start"; ts: number; simId: string }
  | { kind: "report:ready"; ts: number; simId: string; resilienceScore: number; resilienceGrade: string }
  | { kind: "report:error"; ts: number; simId: string; message: string }
  | { kind: "chain:deploy:start"; ts: number; simId: string; step: string }
  | { kind: "chain:deploy:progress"; ts: number; simId: string; step: string; message: string }
  | { kind: "chain:deploy:complete"; ts: number; simId: string; programs: string[] }
  | { kind: "chain:deploy:error"; ts: number; simId: string; message: string }
  | {
      kind: "chain:prestake:start";
      ts: number;
      simId: string;
      total: number;
    }
  | {
      kind: "chain:prestake:progress";
      ts: number;
      simId: string;
      agentId: string;
      current: number;
      total: number;
      succeeded: number;
      failed: number;
    }
  | {
      kind: "chain:prestake:complete";
      ts: number;
      simId: string;
      total: number;
      succeeded: number;
      failed: number;
      durationMs: number;
    }
  | { kind: "error"; ts: number; tick: number | null; message: string }
  | { kind: "log"; ts: number; level: "info" | "warn" | "error"; message: string };

export interface StatusSnapshot {
  simId: string;
  status: SimStatus;
  tick: number;
  updatedAt: number;
  hasReport?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// UI-side derived types
// ────────────────────────────────────────────────────────────────────────────

export interface FeedEntry {
  id: string;
  ts: number;
  tick: number;
  agentId: string;
  action: ActionType;
  amount: number | null;
  reasoning: string;
  success: boolean;
  txSignature: string | null;
}

export interface LogEntry {
  id: string;
  ts: number;
  level: "info" | "warn" | "error" | "system";
  message: string;
}

export type ThreatLevel = "calm" | "watch" | "elevated" | "critical" | "death_spiral";

export interface AgentRuntime {
  id: string;
  type: AgentType | "unknown";
  name: string;
  balance: number;
  lastAction?: AgentAction;
}
