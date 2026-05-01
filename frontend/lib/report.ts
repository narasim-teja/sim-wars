/**
 * Mirror of sim-engine/src/report/types.ts. Kept in lockstep manually.
 */

import { API_BASE } from "./api";

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

export interface SimulationReport {
  simId: string;
  meta: {
    generatedAtMs: number;
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
  narrative: string;
}

export async function fetchReport(simId: string): Promise<SimulationReport | null> {
  const r = await fetch(`${API_BASE}/api/sim/${simId}/report`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /api/sim/${simId}/report failed: ${r.status}`);
  return (await r.json()) as SimulationReport;
}
