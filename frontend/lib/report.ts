/**
 * Mirror of sim-engine/src/report/types.ts. Kept in lockstep manually.
 */

import { apiBase } from "./api";

export type ResilienceGrade = "S" | "A" | "B" | "C" | "D" | "F";

export interface FailureMode {
  name: string;
  detectedAtTick: number;
  severity: number;
  description: string;
  responsibleAgents: string[];
}

export interface AgentRanking {
  agentId: string;
  agentType: string;
  realizedPnlUsd: number;
  totalActions: number;
  largestTradeAmount: number;
  firstExitTick: number | null;
  characterization: string;
}

export interface AttackVector {
  label: string;
  startTick: number;
  endTick: number;
  timeline: string[];
}

export interface Recommendation {
  parameter: string;
  suggestedValue: string;
  rationale: string;
}

export interface HistoricalComparison {
  collapseName: string;
  similarityScore: number;
  reasoning: string;
}

export interface ChainActivity {
  cluster: string;
  explorerBase: string | null;
  totalSuccessful: number;
  totalOnChain: number;
  onChainPct: number;
  byAction: { action: string; successful: number; onChain: number }[];
  programs: { name: string; address: string }[];
  /**
   * Deployed mints. `decimals` reflects the actual on-chain SPL mint;
   * `decimalsClampedFrom` is set iff the deploy script clamped (typically
   * EVM-style 18 → Solana-safe 9).
   */
  mints: { name: string; address: string; decimals: number; decimalsClampedFrom?: number }[];
  pool: { address: string } | null;
  /** Programs intentionally not deployed (config section never grounded). */
  skippedPrograms?: {
    program: "staking" | "governance";
    reason: string;
    enableHint: string;
  }[];
}

/** Per-section "did the user ground this?" map. */
export interface FieldSources {
  extracted: string[];
  sectionExtracted: {
    token: boolean;
    staking: boolean;
    amm: boolean;
    governance: boolean;
    stablecoin: boolean;
    veToken: boolean;
  };
}

export interface SimulationReport {
  simId: string;
  meta: {
    generatedAtMs: number;
    /** Optional — populated when extraction provided a metadata block. */
    protocolName?: string;
    tokenSymbol?: string;
    quoteSymbol?: string;
    protocolKind?: string;
    totalTicks: number;
    finalStatus: string;
    agentCount: number;
    initialPrice: number;
    finalPrice: number;
    pricePctChange: number;
    deathSpiralDetected: boolean;
    deathSpiralAtTick: number | null;
    minPeg: number | null;
    finalReservePct: number | null;
    finalGini: number;
    llmModel: string;
  };
  resilienceScore: number;
  resilienceGrade: ResilienceGrade;
  executiveSummary: string;
  failureModes: FailureMode[];
  agentRankings: AgentRanking[];
  attackVectors: AttackVector[];
  recommendations: Recommendation[];
  comparison: HistoricalComparison | null;
  /** Optional — present when the run was on-chain and a deployment was found. */
  chainActivity?: ChainActivity | null;
  /** Optional — present when the request carried `extractedFields`. */
  fieldSources?: FieldSources;
  narrative: string;
}

export async function fetchReport(simId: string): Promise<SimulationReport | null> {
  const r = await fetch(`${apiBase()}/api/sim/${simId}/report`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /api/sim/${simId}/report failed: ${r.status}`);
  return (await r.json()) as SimulationReport;
}
