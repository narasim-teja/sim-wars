/**
 * Post-simulation report types. Returned by `report/generator.ts` and rendered
 * by the frontend report panel + shareable /report/[id] route.
 */

export type ResilienceGrade = "S" | "A" | "B" | "C" | "D" | "F";

export interface FailureMode {
  /** Short noun-phrase: "yield-driven reserve drain", "governance capture", … */
  name: string;
  /** Tick at which the mode crystallized in the data. */
  detectedAtTick: number;
  /** 0–100; how confident the report is that this mode actually happened. */
  severity: number;
  /** 1–3 sentences explaining the mechanism the LLM reads off the transcript. */
  description: string;
  /** Agent IDs whose actions drove or accelerated this mode. */
  responsibleAgents: string[];
}

export interface AgentRanking {
  agentId: string;
  agentType: string;
  /**
   * Net realized PnL in USDC terms: (final.usdc + final.token * finalPrice +
   * final.staked * finalPrice) − (initial equivalent in USDC). Positive means
   * the agent extracted value from the run.
   */
  realizedPnlUsd: number;
  /** Number of executed (success=true) actions across the whole sim. */
  totalActions: number;
  /** Largest single trade by absolute amount of token. */
  largestTradeAmount: number;
  /** Tick at which this agent first sold or unstaked, or null if never. */
  firstExitTick: number | null;
  /** A 1-sentence behavioral characterization, written by the LLM. */
  characterization: string;
}

export interface AttackVector {
  /** Short label: "Whale-led capitulation cascade", "Sybil-amplified panic", … */
  label: string;
  /** Tick range over which the vector unfolded. */
  startTick: number;
  endTick: number;
  /** Step-by-step narrative — each step references at least one agentId or metric. */
  timeline: string[];
}

export interface Recommendation {
  /** Targeted parameter, e.g. "staking.baseAPY" or "governance.quorumPercent". */
  parameter: string;
  /** Suggested new value (string so we don't lose precision). */
  suggestedValue: string;
  /** 1–2 sentences explaining the expected delta vs. the failure mode. */
  rationale: string;
}

export interface HistoricalComparison {
  /** Reference event the run most resembles. */
  collapseName: string;
  similarityScore: number; // 0–100
  reasoning: string;
}

/**
 * On-chain activity fingerprint. Set when the run was launched with
 * `onChain: true` and a deployment manifest exists; null otherwise.
 *
 * The frontend uses this to render verifiable "actually ran on Solana"
 * proof — explorer links for the deployed mints/programs and a per-action
 * count of how many submissions had a real tx_signature attached.
 */
export interface ChainActivity {
  cluster: string;
  /** Best-effort explorer base URL inferred from `cluster`; null on unknowns. */
  explorerBase: string | null;
  /** Total successful actions excluding `hold`. */
  totalSuccessful: number;
  /** Successful actions that landed on chain (tx_signature IS NOT NULL). */
  totalOnChain: number;
  /** 0–100. (totalOnChain / totalSuccessful) × 100, rounded to 1 dp. */
  onChainPct: number;
  byAction: { action: string; successful: number; onChain: number }[];
  programs: { name: string; address: string }[];
  mints: { name: string; address: string }[];
  pool: { address: string } | null;
  /**
   * Programs the deployment plan intentionally skipped because the user
   * never extracted or edited their config block. Useful so the report
   * doesn't claim to have stress-tested e.g. staking when no staking
   * program was ever deployed.
   */
  skippedPrograms?: {
    program: "staking" | "governance" | "stablecoin";
    reason: string;
    enableHint: string;
  }[];
}

/**
 * Per-section source map: which engine inputs were grounded in the source
 * (or edited by the user) vs. silently filled by schema defaults. Keyed by
 * top-level config section. The frontend uses this to badge defaulted
 * parameters in the report so reviewers can tell what's grounded.
 */
export interface FieldSources {
  /** All dotted paths the user grounded or edited (verbatim from the request). */
  extracted: string[];
  /**
   * Convenience flags: was *any* field in this section grounded? `false`
   * means every value in that section came from schema defaults — so any
   * "we tested staking" claim in the narrative should be read with skepticism.
   */
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
  /** Engine-derived metadata captured at report time. */
  meta: {
    generatedAtMs: number;
    /** Protocol/token identity carried over from config.metadata, when present. */
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
    /** Used so the UI knows whether an AI narrative was actually attached. */
    llmModel: string;
  };
  /** 0–100; engine-derived blend of price stability + reserve survival + Gini. */
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
  /**
   * Source map for parameters under test — only populated when the request
   * carried `extractedFields`. Absent for legacy preset runs.
   */
  fieldSources?: FieldSources;
  /**
   * Raw LLM text. Helpful when the structured fields look thin and the user
   * wants the model's full take.
   */
  narrative: string;
}
