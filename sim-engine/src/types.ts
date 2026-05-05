// ============================================================
// Core Simulation Types
// ============================================================

export interface SimulationConfig {
  metadata?: {
    /** Human protocol name extracted from source docs, e.g. "Acme DAO". */
    protocolName?: string;
    /** Base token symbol under test. Defaults to TOKEN when unknown. */
    tokenSymbol?: string;
    /** Quote / settlement token symbol. Defaults to USDC when unknown. */
    quoteSymbol?: string;
    /** Extraction-level protocol classification. */
    protocolKind?: string;
  };
  token: {
    totalSupply: number;
    decimals: number;
    allocations: {
      name: string;
      percent: number;
      vestingMonths: number;
      /**
       * Months of cliff before any tokens unlock. After the cliff, the
       * remaining `vestingMonths - cliffMonths` are released linearly.
       * 0 means no cliff (linear from t=0). Ignored when `vestingMonths` is 0.
       */
      cliffMonths?: number;
    }[];
  };
  staking: {
    baseAPY: number;
    maxAPY: number;
    lockPeriodTicks: number;
    unstakePenaltyPercent: number;
    /**
     * Cooldown between request_unstake and complete_unstake (in ticks).
     * Optional: defaults to 1 tick when missing — preserves prior behavior
     * before this field was extracted from the whitepaper.
     */
    unstakeCooldownTicks?: number;
    /**
     * Per-tick top-up amount for the staking reward vault, expressed as a
     * fraction of the total staked supply (e.g. 0.001 = 0.1%). Used to model
     * an emissions schedule so the reward vault doesn't drain during long
     * runs. 0 disables top-ups (one-shot seeding only). Optional, defaults to 0.
     */
    rewardEmissionRate?: number;
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
    /**
     * Engine-side risk model for peg / reserve mechanics. These are neutral
     * protocol parameters; LUNA/UST is one fixture that fills them, not a
     * special backend code path.
     */
    riskModel?: {
      /** Fraction of gross yield paid by organic borrower/protocol revenue. */
      borrowerRevenueRatio?: number;
      /** Peg threshold below which redemptions/mint-burn pressure starts. */
      redemptionThreshold?: number;
      /** Max fraction of stablecoin supply redeemed per tick. */
      maxRedemptionPercentPerTick?: number;
      /** Multiplier from peg deviation to redemption percentage. */
      redemptionRateMultiplier?: number;
      /** Pressure cap contributed by recent sell/unstake volume. */
      sellPressureCoefficient?: number;
      /** Pressure cap contributed by reserve depletion. */
      reservePressureCoefficient?: number;
      /** Pressure cap contributed by negative price momentum. */
      momentumPressureCoefficient?: number;
    };
  };
  /**
   * veToken-style locking. When `enabled`, stake actions take a lock duration
   * (months); the engine refuses unstake until the lock expires and weights
   * governance votes by the remaining lock fraction.
   *
   * Generalizes Curve veCRV semantics — applies to any protocol whose
   * whitepaper describes a vote-escrow / time-weighted-stake mechanism.
   */
  veToken?: {
    enabled: boolean;
    /** Maximum lock duration in months. Curve is 48; many forks use 24 or 12. */
    maxLockMonths: number;
    /** "linear-decay" → weight scales with remaining lock; "constant" → fixed boost. */
    voteWeightCurve: "linear-decay" | "constant";
    /** Multiplier applied at max-lock; below max-lock weight is interpolated. */
    boostMultiplier: number;
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
  /**
   * Routing hint for the LLM router:
   * - "fast"       → boost model (cheap/fast) — reactive retail personas
   * - "standard"   → primary model (default)
   * - "reasoning"  → primary model, larger max_tokens (coordinated attackers)
   */
  complexity?: "fast" | "standard" | "reasoning";
  /**
   * Per-tick LLM activation probability in [0, 1]. Lower means the agent
   * is dormant most ticks (no prompt built, no LLM call) and contributes
   * a default "hold" action. Modeled after OASIS's activation probability:
   * real markets are dominated by a small share of active wallets at any
   * moment. Default 1.0 (always active) preserves prior behavior; the
   * orchestrator's activation policy may further modulate this by
   * market volatility. Undefined treated as 1.0.
   */
  activation?: number;
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
  coordinationEdges: { a: string; b: string; score: number }[];
  poolReserveA: number;
  poolReserveB: number;
  // Stablecoin mechanism telemetry
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
  /**
   * LLM usage for this tick — drained from the orchestrator's client after
   * the batch completes. Undefined when the client doesn't report usage
   * (mock provider in some tests).
   */
  llmUsage?: import("./llm/types").LLMUsage;
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
