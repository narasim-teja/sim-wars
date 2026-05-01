/**
 * Post-simulation report generator.
 *
 * Reads everything the SimDatabase has captured for a run, derives engine-side
 * stats deterministically (resilience score, agent rankings, comparison
 * heuristics), then asks one LLM call for the qualitative pieces — executive
 * summary, failure-mode descriptions, attack-vector timelines, recommendations.
 *
 * The deterministic pieces are computed first so the report still has signal
 * even if the LLM call fails: callers get back a partial report with default
 * narrative + empty attack vectors rather than nothing.
 */

import type { LLMClient } from "../llm/types";
import type { SimDatabase } from "../db/database";
import type {
  AgentAction,
  AgentPersona,
  SimulationConfig,
  SimulationState,
} from "../types";
import type {
  SimulationReport,
  FailureMode,
  AgentRanking,
  AttackVector,
  Recommendation,
  HistoricalComparison,
  ResilienceGrade,
  ChainActivity,
} from "./types";
import { existsSync, readFileSync } from "node:fs";
import { perRunDeploymentPath, type Deployment } from "../chain/sdk";

export interface GenerateReportOptions {
  simId: string;
  /** SimulationConfig as it ran — needed for recommendation parameter mapping. */
  config: SimulationConfig;
  /** Personas as they ran — needed for agentType + initial-capital normalization. */
  agents: AgentPersona[];
  db: SimDatabase;
  llm: LLMClient;
  /** True if the death spiral threshold tripped (engine-side flag). */
  deathSpiralDetected: boolean;
  deathSpiralAtTick: number | null;
  finalStatus: string;
  /** Cap LLM transcript length so the prompt stays under ~16k tokens. */
  maxTickLines?: number;
  /** Cap the number of representative actions per agent included in the prompt. */
  maxActionsPerAgent?: number;
}

const MAX_TICK_LINES_DEFAULT = 60;
const MAX_ACTIONS_PER_AGENT_DEFAULT = 6;

export async function generateReport(opts: GenerateReportOptions): Promise<SimulationReport> {
  const { simId, config, agents, db, llm, deathSpiralDetected, deathSpiralAtTick, finalStatus } = opts;
  const maxTickLines = opts.maxTickLines ?? MAX_TICK_LINES_DEFAULT;
  const maxActionsPerAgent = opts.maxActionsPerAgent ?? MAX_ACTIONS_PER_AGENT_DEFAULT;

  const tickStates = db.getTickStates(simId);
  const actionsByAgent = new Map<string, AgentAction[]>();
  for (const persona of agents) {
    actionsByAgent.set(persona.id, db.getAgentHistory(simId, persona.id, 200));
  }

  // Chain-activity proof. Only populated when a deployment manifest exists
  // for this sim (i.e. the run was on-chain). Null otherwise — the frontend
  // hides the section.
  const chainActivity = computeChainActivity(simId, db);

  const meta = computeMeta({
    simId,
    tickStates,
    finalStatus,
    deathSpiralDetected,
    deathSpiralAtTick,
    agentCount: agents.length,
    initialPrice: config.amm.initialPrice,
    llmModelName: llm.name,
  });

  const resilienceScore = computeResilience({
    tickStates,
    config,
    deathSpiralDetected,
  });
  const resilienceGrade = gradeFromScore(resilienceScore);

  const agentRankings = computeAgentRankings({
    agents,
    actionsByAgent,
    finalState: tickStates.at(-1) ?? null,
    initialPrice: config.amm.initialPrice,
  });

  // Best-guess deterministic comparison (LLM may overwrite below).
  const comparison = inferComparison({
    config,
    deathSpiralDetected,
    pricePctChange: meta.pricePctChange,
    minPeg: meta.minPeg,
    finalReservePct: meta.finalReservePct,
  });

  // Build prompt.
  const transcript = buildTranscript(tickStates, maxTickLines);
  const agentLines = buildAgentLines(agents, actionsByAgent, maxActionsPerAgent);
  const prompt = buildReportPrompt({
    config,
    meta,
    resilienceScore,
    transcript,
    agentLines,
    deathSpiralDetected,
    deathSpiralAtTick,
  });

  let narrative = "";
  let llmFailureModes: FailureMode[] = [];
  let llmAttackVectors: AttackVector[] = [];
  let llmRecommendations: Recommendation[] = [];
  let llmExecSummary = "";
  let llmCharacterizations: Record<string, string> = {};
  let llmComparison: HistoricalComparison | null = null;

  try {
    narrative = await llm.generateRaw(prompt, { maxTokens: 2400 });
    const parsed = extractJson(narrative);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      llmExecSummary = stringOr(obj.executiveSummary, "");
      llmFailureModes = parseFailureModes(obj.failureModes);
      llmAttackVectors = parseAttackVectors(obj.attackVectors);
      llmRecommendations = parseRecommendations(obj.recommendations);
      llmCharacterizations = parseCharacterizations(obj.agentCharacterizations);
      llmComparison = parseComparison(obj.comparison);
    }
  } catch (err) {
    narrative = `report LLM call failed: ${(err as Error).message}`;
  }

  // Merge LLM characterizations into agent rankings.
  const rankings = agentRankings.map((r) => ({
    ...r,
    characterization: llmCharacterizations[r.agentId] || r.characterization,
  }));

  // Default executive summary if the LLM didn't produce one.
  const executiveSummary = llmExecSummary || synthesizeExecSummary({
    deathSpiralDetected,
    pricePctChange: meta.pricePctChange,
    finalReservePct: meta.finalReservePct,
    resilienceScore,
    resilienceGrade,
  });

  // Recommendations: if the LLM was silent, fall back to engine-derived ones.
  const recommendations = llmRecommendations.length > 0
    ? llmRecommendations
    : engineRecommendations(config, meta, deathSpiralDetected);

  return {
    simId,
    meta,
    resilienceScore,
    resilienceGrade,
    executiveSummary,
    failureModes: llmFailureModes.length > 0 ? llmFailureModes : engineFailureModes({
      tickStates,
      meta,
      deathSpiralDetected,
      deathSpiralAtTick,
    }),
    agentRankings: rankings,
    attackVectors: llmAttackVectors,
    recommendations,
    comparison: llmComparison ?? comparison,
    chainActivity,
    narrative,
  };
}

/**
 * Build the `chainActivity` block by joining the on-chain deployment manifest
 * (program IDs, mints, pool) with the per-action submission counts from the
 * SimDatabase. Returns null when:
 *   - no per-run `deployment.json` exists (run was not on-chain), or
 *   - the manifest fails to parse (deploy script crashed mid-flight).
 *
 * The deployment manifest is loaded explicitly from the per-run path rather
 * than via `loadDeployment()` — the latter would also fall back to the legacy
 * top-level `.local/deployment.json`, which is stale across sim sessions.
 */
function computeChainActivity(simId: string, db: SimDatabase): ChainActivity | null {
  const manifestPath = perRunDeploymentPath(simId);
  if (!existsSync(manifestPath)) return null;
  let dep: Deployment;
  try {
    dep = JSON.parse(readFileSync(manifestPath, "utf-8")) as Deployment;
  } catch {
    return null;
  }

  const stats = db.getActionStats(simId);
  const onChainPct = stats.totalSuccessful > 0
    ? Math.round((stats.totalOnChain / stats.totalSuccessful) * 1000) / 10
    : 0;

  const programs: { name: string; address: string }[] = [
    { name: "token_mint", address: dep.programs.tokenMint },
    { name: "amm_dex", address: dep.programs.ammDex },
  ];
  if (dep.programs.staking) programs.push({ name: "staking", address: dep.programs.staking });
  if (dep.programs.governance) programs.push({ name: "governance", address: dep.programs.governance });

  const mints = [
    { name: "LUNA", address: dep.mints.luna },
    { name: "UST", address: dep.mints.ust },
  ];

  return {
    cluster: dep.cluster,
    explorerBase: explorerBaseFor(dep.cluster),
    totalSuccessful: stats.totalSuccessful,
    totalOnChain: stats.totalOnChain,
    onChainPct,
    byAction: stats.byAction,
    programs,
    mints,
    pool: dep.pool ? { address: dep.pool.address } : null,
  };
}

/**
 * Best-effort mapping from RPC URL → block-explorer base URL.
 * Localnet is intentionally null because Solana Explorer doesn't surface
 * tx data for ephemeral test-validator instances.
 */
function explorerBaseFor(rpcUrl: string): string | null {
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) return null;
  if (rpcUrl.includes("devnet")) return "https://explorer.solana.com/?cluster=devnet";
  if (rpcUrl.includes("testnet")) return "https://explorer.solana.com/?cluster=testnet";
  if (rpcUrl.includes("helius")) {
    // Helius mainnet endpoints don't put "mainnet" in the URL — assume mainnet.
    return "https://explorer.solana.com/";
  }
  return "https://explorer.solana.com/";
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine-side derivations
// ─────────────────────────────────────────────────────────────────────────────

function computeMeta(args: {
  simId: string;
  tickStates: SimulationState[];
  finalStatus: string;
  deathSpiralDetected: boolean;
  deathSpiralAtTick: number | null;
  agentCount: number;
  initialPrice: number;
  llmModelName: string;
}): SimulationReport["meta"] {
  const { tickStates, finalStatus, deathSpiralDetected, deathSpiralAtTick, agentCount, initialPrice, llmModelName } = args;
  const last = tickStates.at(-1);
  const finalPrice = last?.tokenPrice ?? initialPrice;
  const pricePctChange = initialPrice > 0 ? ((finalPrice - initialPrice) / initialPrice) * 100 : 0;
  const minPeg = tickStates.reduce<number | null>((acc, s) => {
    if (s.pegPrice == null) return acc;
    return acc == null ? s.pegPrice : Math.min(acc, s.pegPrice);
  }, null);
  const finalReservePct = last && last.reserveBalance != null && last.initialReserveBalance && last.initialReserveBalance > 0
    ? (last.reserveBalance / last.initialReserveBalance) * 100
    : null;
  const finalGini = last?.giniCoefficient ?? 0;
  return {
    generatedAtMs: Date.now(),
    totalTicks: tickStates.length,
    finalStatus,
    agentCount,
    initialPrice,
    finalPrice,
    pricePctChange,
    deathSpiralDetected,
    deathSpiralAtTick,
    minPeg,
    finalReservePct,
    finalGini,
    llmModel: llmModelName,
  };
}

/**
 * Resilience score: 0–100. Three weighted ingredients:
 *   - Price stability: how close finalPrice is to initialPrice (40%).
 *   - Reserve survival: % of initial reserve still on the books (35%).
 *   - Wealth distribution: 1 − finalGini (25%).
 *
 * Death spiral hard-floors the score at 15 so a S grade is impossible if
 * price has collapsed below 1% of initial.
 */
function computeResilience(args: {
  tickStates: SimulationState[];
  config: SimulationConfig;
  deathSpiralDetected: boolean;
}): number {
  const { tickStates, config, deathSpiralDetected } = args;
  const last = tickStates.at(-1);
  if (!last) return 0;

  const initialPrice = config.amm.initialPrice;
  const priceRatio = initialPrice > 0 ? Math.min(1, last.tokenPrice / initialPrice) : 0;
  const priceComponent = Math.max(0, priceRatio) * 40;

  let reserveComponent = 35;
  if (last.initialReserveBalance && last.initialReserveBalance > 0 && last.reserveBalance != null) {
    const ratio = Math.max(0, Math.min(1, last.reserveBalance / last.initialReserveBalance));
    reserveComponent = ratio * 35;
  }

  const giniComponent = Math.max(0, Math.min(1, 1 - last.giniCoefficient)) * 25;

  let score = priceComponent + reserveComponent + giniComponent;
  if (deathSpiralDetected) score = Math.min(score, 15);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function gradeFromScore(score: number): ResilienceGrade {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "F";
}

function computeAgentRankings(args: {
  agents: AgentPersona[];
  actionsByAgent: Map<string, AgentAction[]>;
  finalState: SimulationState | null;
  initialPrice: number;
}): AgentRanking[] {
  const { agents, actionsByAgent, finalState, initialPrice } = args;
  const finalPrice = finalState?.tokenPrice ?? initialPrice;

  const rankings: AgentRanking[] = agents.map((persona) => {
    const actions = actionsByAgent.get(persona.id) ?? [];
    const successful = actions.filter((a) => a.success);
    const initialEquivUsd = persona.initialCapital.token * initialPrice + persona.initialCapital.usdc;

    // Crude PnL: sum signed flows. buy = USDC out, sell/unstake = USDC in.
    let usdNet = persona.initialCapital.usdc;
    let tokenNet = persona.initialCapital.token; // includes staked
    for (const a of successful) {
      const amt = a.amount ?? 0;
      if (a.action === "buy") {
        // amt is USDC spent
        usdNet -= amt;
        // approximate tokens received using midpoint of init/final price
        const midPrice = (initialPrice + finalPrice) / 2 || initialPrice;
        if (midPrice > 0) tokenNet += amt / midPrice;
      } else if (a.action === "sell") {
        tokenNet -= amt;
        const midPrice = (initialPrice + finalPrice) / 2 || initialPrice;
        usdNet += amt * midPrice;
      }
      // stake/unstake/votes don't shift USD vs token totals materially
    }
    const realizedPnlUsd = (tokenNet * finalPrice + usdNet) - initialEquivUsd;

    const largestTradeAmount = successful.reduce((m, a) => {
      const amt = Math.abs(a.amount ?? 0);
      return amt > m ? amt : m;
    }, 0);

    const firstExit = successful.find((a) => a.action === "sell" || a.action === "unstake");
    const firstExitTick = firstExit ? firstExit.tick : null;

    return {
      agentId: persona.id,
      agentType: persona.type,
      realizedPnlUsd,
      totalActions: successful.length,
      largestTradeAmount,
      firstExitTick,
      characterization: defaultCharacterization(persona, successful),
    };
  });

  rankings.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  return rankings;
}

function defaultCharacterization(persona: AgentPersona, successful: AgentAction[]): string {
  const sells = successful.filter((a) => a.action === "sell").length;
  const buys = successful.filter((a) => a.action === "buy").length;
  const stakes = successful.filter((a) => a.action === "stake").length;
  const unstakes = successful.filter((a) => a.action === "unstake").length;
  const votes = successful.filter((a) => a.action === "vote_yes" || a.action === "vote_no").length;
  return `${persona.type} · ${successful.length} actions (sell:${sells} buy:${buys} stake:${stakes} unstake:${unstakes} vote:${votes})`;
}

function engineFailureModes(args: {
  tickStates: SimulationState[];
  meta: SimulationReport["meta"];
  deathSpiralDetected: boolean;
  deathSpiralAtTick: number | null;
}): FailureMode[] {
  const { tickStates, meta, deathSpiralDetected, deathSpiralAtTick } = args;
  const modes: FailureMode[] = [];
  if (deathSpiralDetected) {
    modes.push({
      name: "Price death spiral",
      detectedAtTick: deathSpiralAtTick ?? meta.totalTicks,
      severity: 95,
      description: `Token price fell below 1% of initial (${meta.initialPrice}). Engine flagged terminal cascade at tick ${deathSpiralAtTick ?? "N/A"}.`,
      responsibleAgents: [],
    });
  }
  if (meta.minPeg != null && meta.minPeg < 0.97) {
    modes.push({
      name: "Stablecoin peg break",
      detectedAtTick: pegBreakTick(tickStates) ?? 0,
      severity: 80,
      description: `Stablecoin de-pegged below $0.97 (min ${meta.minPeg.toFixed(4)}). Reserve depletion + redemption pressure overwhelmed the mint/burn arbitrage.`,
      responsibleAgents: [],
    });
  }
  if (meta.finalReservePct != null && meta.finalReservePct < 30) {
    modes.push({
      name: "Reserve depletion",
      detectedAtTick: meta.totalTicks,
      severity: 70,
      description: `Reserve drained to ${meta.finalReservePct.toFixed(1)}% of initial. Yield subsidy outpaced borrower revenue.`,
      responsibleAgents: [],
    });
  }
  if (meta.finalGini > 0.7) {
    modes.push({
      name: "Wealth concentration",
      detectedAtTick: meta.totalTicks,
      severity: 60,
      description: `Final Gini coefficient ${meta.finalGini.toFixed(3)} indicates extreme concentration; few wallets own most of the supply.`,
      responsibleAgents: [],
    });
  }
  return modes;
}

function pegBreakTick(states: SimulationState[]): number | null {
  for (const s of states) {
    if (s.pegPrice != null && s.pegPrice < 0.97) return s.tick;
  }
  return null;
}

function engineRecommendations(
  config: SimulationConfig,
  meta: SimulationReport["meta"],
  deathSpiralDetected: boolean,
): Recommendation[] {
  const recs: Recommendation[] = [];
  if (config.staking.baseAPY > 12) {
    const target = Math.max(4, Math.round(config.staking.baseAPY * 0.4));
    recs.push({
      parameter: "staking.baseAPY",
      suggestedValue: `${target}`,
      rationale: `Current ${config.staking.baseAPY}% APY exceeds sustainable yield. Anchor-style subsidies bleed reserves; a dynamic ${target}% target tied to fee revenue prevents runaway drain.`,
    });
  }
  if (config.staking.lockPeriodTicks === 0 && deathSpiralDetected) {
    recs.push({
      parameter: "staking.lockPeriodTicks",
      suggestedValue: "5",
      rationale: "Zero lock period let yield farmers exit instantly during the cascade. A 5-tick lock breaks the immediate-unstake-then-sell loop.",
    });
  }
  if (meta.finalGini > 0.7) {
    recs.push({
      parameter: "token.allocations",
      suggestedValue: "max 5% per bucket, longer vesting",
      rationale: `Gini ${meta.finalGini.toFixed(2)} signals concentration risk. Cap any single allocation at 5% and stretch vesting to ≥36 months.`,
    });
  }
  if (config.governance.quorumPercent < 15) {
    recs.push({
      parameter: "governance.quorumPercent",
      suggestedValue: "15",
      rationale: `Current ${config.governance.quorumPercent}% quorum lets a small staked plurality push proposals — visible in the run via coordinated voting blocks.`,
    });
  }
  // veToken-specific: if locks exist but inflation is high, the long lock
  // alone won't keep defenders aligned — emission rate matters more.
  if (config.veToken?.enabled && (config.staking.rewardEmissionRate ?? 0) > 0.0005) {
    recs.push({
      parameter: "staking.rewardEmissionRate",
      suggestedValue: `${((config.staking.rewardEmissionRate ?? 0) * 0.5).toExponential(2)}`,
      rationale: `Per-tick emission rate ${(config.staking.rewardEmissionRate ?? 0).toExponential(2)} dilutes locked holders faster than veToken voting weight can compensate. Halving the rate preserves locked-holder governance influence.`,
    });
  }
  // Catch-all so the report never ships with zero recommendations when the
  // sim was meaningfully off-baseline (sub-A grade or any failure mode).
  if (recs.length === 0 && (meta.finalGini > 0.5 || Math.abs(meta.pricePctChange) > 20)) {
    recs.push({
      parameter: "amm.feeTier",
      suggestedValue: `${Math.min(1, (config.amm.feeTier || 0.3) * 1.5).toFixed(2)}`,
      rationale: `Price moved ${meta.pricePctChange.toFixed(1)}% over ${meta.totalTicks} ticks at fee=${config.amm.feeTier}%. A modestly higher fee dampens reflexive trading without choking liquidity.`,
    });
  }
  return recs;
}

function synthesizeExecSummary(args: {
  deathSpiralDetected: boolean;
  pricePctChange: number;
  finalReservePct: number | null;
  resilienceScore: number;
  resilienceGrade: ResilienceGrade;
}): string {
  const { deathSpiralDetected, pricePctChange, finalReservePct, resilienceScore, resilienceGrade } = args;
  if (deathSpiralDetected) {
    return `Tokenomics design failed under adversarial load: price collapsed (${pricePctChange.toFixed(1)}%), reserve at ${finalReservePct?.toFixed(1) ?? "n/a"}%. Resilience ${resilienceScore}/100 (grade ${resilienceGrade}). The simulation reproduced a terminal cascade — agents extracted value faster than the protocol could defend.`;
  }
  return `Tokenomics design held up: price moved ${pricePctChange.toFixed(1)}%, reserve at ${finalReservePct?.toFixed(1) ?? "n/a"}%. Resilience ${resilienceScore}/100 (grade ${resilienceGrade}). The simulation surfaced ${resilienceScore < 60 ? "structural weaknesses worth addressing" : "no acute failure modes"}.`;
}

function inferComparison(args: {
  config: SimulationConfig;
  deathSpiralDetected: boolean;
  pricePctChange: number;
  minPeg: number | null;
  finalReservePct: number | null;
}): HistoricalComparison | null {
  const { config, deathSpiralDetected, pricePctChange, minPeg, finalReservePct } = args;
  // Heuristic: high APY + algorithmic stablecoin + reserve drain ⇒ LUNA
  if (
    config.stablecoin?.enabled &&
    config.staking.baseAPY > 15 &&
    deathSpiralDetected
  ) {
    let sim = 60;
    if (minPeg != null && minPeg < 0.95) sim += 15;
    if (finalReservePct != null && finalReservePct < 20) sim += 10;
    if (pricePctChange < -90) sim += 10;
    return {
      collapseName: "Terra LUNA / UST (May 2022)",
      similarityScore: Math.min(99, sim),
      reasoning: "Algorithmic stablecoin with subsidized staking yield, reserve drain, and a price death spiral mirrors the LUNA pattern.",
    };
  }
  // veToken / Curve-style heuristic. Either signal qualifies:
  //   - explicit veToken section enabled with a non-trivial max lock (≥24mo);
  //   - or legacy `staking.lockPeriodTicks > 100` (pre-veToken-section configs).
  // Previous version only checked the legacy field, which silently null'd the
  // comparison for the Curve-extracted veCRV scenario (lockPeriodTicks=0 but
  // veToken.maxLockMonths=48).
  const hasLongLock =
    (config.veToken?.enabled === true && (config.veToken.maxLockMonths ?? 0) >= 24) ||
    config.staking.lockPeriodTicks > 100;
  if (hasLongLock && !deathSpiralDetected) {
    return {
      collapseName: "Curve veCRV (resilience reference)",
      similarityScore: 55,
      reasoning: "Long lock-up and modest yield kept defenders aligned through stress; no terminal cascade observed.",
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM prompt + parsing
// ─────────────────────────────────────────────────────────────────────────────

interface PromptArgs {
  config: SimulationConfig;
  meta: SimulationReport["meta"];
  resilienceScore: number;
  transcript: string;
  agentLines: string;
  deathSpiralDetected: boolean;
  deathSpiralAtTick: number | null;
}

function buildReportPrompt(args: PromptArgs): string {
  const { config, meta, resilienceScore, transcript, agentLines, deathSpiralDetected, deathSpiralAtTick } = args;
  return `You are an adversarial DeFi auditor. A live, multi-agent tokenomics simulation just finished and you must write the post-mortem report.

CONFIG (the parameters under test):
  totalSupply: ${config.token.totalSupply}
  initialPrice: $${config.amm.initialPrice}
  initialLiquidity: ${config.amm.initialLiquidity}
  staking.baseAPY: ${config.staking.baseAPY}% (lock=${config.staking.lockPeriodTicks}t, cooldown_penalty=${config.staking.unstakePenaltyPercent}%)
  governance.quorumPercent: ${config.governance.quorumPercent}%
  governance.proposalThresholdPercent: ${config.governance.proposalThresholdPercent}%
  stablecoin.enabled: ${!!config.stablecoin?.enabled}
  stablecoin.reserveAmount: ${config.stablecoin?.reserveAmount ?? 0}

ENGINE-DERIVED OUTCOME:
  totalTicks: ${meta.totalTicks}
  finalPrice: $${meta.finalPrice.toFixed(6)} (${meta.pricePctChange.toFixed(1)}% vs initial)
  finalGini: ${meta.finalGini.toFixed(3)}
  minPeg: ${meta.minPeg == null ? "n/a" : meta.minPeg.toFixed(4)}
  finalReserve%: ${meta.finalReservePct == null ? "n/a" : meta.finalReservePct.toFixed(1)}
  deathSpiral: ${deathSpiralDetected ? `YES (tick ${deathSpiralAtTick})` : "no"}
  resilienceScore: ${resilienceScore}/100

TICK TRANSCRIPT (subsampled — every Nth tick):
${transcript}

AGENT BEHAVIOR (top moves per agent):
${agentLines}

Produce ONE JSON object with these keys (and nothing outside the JSON):
{
  "executiveSummary": string                                    // 3–5 sentences, decision-grade prose
  "failureModes": [                                             // 0–6 items, in causal order
    {
      "name": string,                                           // short noun-phrase
      "detectedAtTick": number,
      "severity": number,                                       // 0–100
      "description": string,                                    // 2–3 sentences explaining the mechanism
      "responsibleAgents": string[]                             // agent IDs whose actions caused or accelerated it
    }
  ],
  "attackVectors": [                                            // 0–4 items, narrative form
    {
      "label": string,
      "startTick": number,
      "endTick": number,
      "timeline": string[]                                      // 3–6 bullet steps; reference agent ids + numbers
    }
  ],
  "agentCharacterizations": {                                   // map of agentId → 1-sentence behavior
    "WHALE_01": "...",
    "FARMER_01": "...",
    ...
  },
  "recommendations": [                                          // 2–5 specific parameter changes
    {
      "parameter": string,                                      // e.g. "staking.baseAPY"
      "suggestedValue": string,                                 // e.g. "8" or "5 ticks lock"
      "rationale": string                                       // 1–2 sentences tying it to a failure mode above
    }
  ],
  "comparison": {                                               // null if nothing fits
    "collapseName": string,                                     // e.g. "Terra LUNA / UST (May 2022)"
    "similarityScore": number,                                  // 0–100
    "reasoning": string                                         // 1–2 sentences
  }
}

Constraints:
- Reference at least one agent ID in each failureMode and attackVector.
- Numbers must match the ENGINE-DERIVED OUTCOME above; do not invent metrics.
- No markdown, no comments, JSON only.`;
}

function buildTranscript(states: SimulationState[], maxLines: number): string {
  if (states.length === 0) return "(no ticks)";
  const stride = Math.max(1, Math.ceil(states.length / maxLines));
  const lines: string[] = [];
  for (let i = 0; i < states.length; i += stride) {
    const s = states[i]!;
    lines.push(
      `t=${s.tick} price=${s.tokenPrice.toFixed(4)} gini=${s.giniCoefficient.toFixed(3)} stakedPct=${(s.totalSupply > 0 ? (s.stakedSupply / s.totalSupply) * 100 : 0).toFixed(1)}` +
      (s.pegPrice != null ? ` peg=${s.pegPrice.toFixed(4)}` : "") +
      (s.reserveBalance != null && s.initialReserveBalance ? ` reserve%=${((s.reserveBalance / s.initialReserveBalance) * 100).toFixed(1)}` : "") +
      (s.recentLargeTrades?.length ? ` largeTrades=${s.recentLargeTrades.slice(0, 3).map((t) => `${t.agentId}:${t.action}:${Math.round(t.amount)}`).join("|")}` : ""),
    );
  }
  // Always include the final tick.
  if (states.length > 0 && lines.length > 0) {
    const last = states.at(-1)!;
    if (!lines.at(-1)!.startsWith(`t=${last.tick} `)) {
      lines.push(`t=${last.tick} (FINAL) price=${last.tokenPrice.toFixed(4)} gini=${last.giniCoefficient.toFixed(3)}`);
    }
  }
  return lines.join("\n");
}

function buildAgentLines(
  personas: AgentPersona[],
  actionsByAgent: Map<string, AgentAction[]>,
  maxPerAgent: number,
): string {
  const lines: string[] = [];
  for (const p of personas) {
    const actions = (actionsByAgent.get(p.id) ?? []).filter((a) => a.success && a.action !== "hold");
    const samples = pickRepresentative(actions, maxPerAgent);
    if (samples.length === 0) {
      lines.push(`  ${p.id} [${p.type}]: held throughout`);
      continue;
    }
    const summary = samples
      .map((a) => `t${a.tick}:${a.action}${a.amount != null ? `:${Math.round(a.amount)}` : ""}`)
      .join(" ");
    lines.push(`  ${p.id} [${p.type}]: ${summary}`);
  }
  return lines.join("\n");
}

/** Pick first, last, and the largest-amount actions to give the LLM a diverse sample. */
function pickRepresentative(actions: AgentAction[], n: number): AgentAction[] {
  if (actions.length <= n) return actions;
  const sortedByAmount = [...actions].sort((a, b) => Math.abs((b.amount ?? 0)) - Math.abs((a.amount ?? 0)));
  const top = sortedByAmount.slice(0, Math.max(1, n - 2));
  const set = new Set(top);
  set.add(actions[0]!);
  set.add(actions.at(-1)!);
  return Array.from(set).sort((a, b) => a.tick - b.tick).slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const tryParse = (s: string) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1]!.trim());
    if (f) return f;
  }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const slice = trimmed.slice(braceStart, braceEnd + 1);
    const s = tryParse(slice);
    if (s) return s;
  }
  return null;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function parseFailureModes(v: unknown): FailureMode[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry): FailureMode | null => {
      if (!entry || typeof entry !== "object") return null;
      const o = entry as Record<string, unknown>;
      if (typeof o.name !== "string") return null;
      return {
        name: o.name,
        detectedAtTick: typeof o.detectedAtTick === "number" ? o.detectedAtTick : 0,
        severity: typeof o.severity === "number" ? Math.max(0, Math.min(100, o.severity)) : 50,
        description: stringOr(o.description, ""),
        responsibleAgents: Array.isArray(o.responsibleAgents)
          ? (o.responsibleAgents.filter((x) => typeof x === "string") as string[])
          : [],
      };
    })
    .filter((x): x is FailureMode => x !== null);
}

function parseAttackVectors(v: unknown): AttackVector[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry): AttackVector | null => {
      if (!entry || typeof entry !== "object") return null;
      const o = entry as Record<string, unknown>;
      if (typeof o.label !== "string") return null;
      return {
        label: o.label,
        startTick: typeof o.startTick === "number" ? o.startTick : 0,
        endTick: typeof o.endTick === "number" ? o.endTick : 0,
        timeline: Array.isArray(o.timeline) ? o.timeline.filter((x) => typeof x === "string") as string[] : [],
      };
    })
    .filter((x): x is AttackVector => x !== null);
}

function parseRecommendations(v: unknown): Recommendation[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry): Recommendation | null => {
      if (!entry || typeof entry !== "object") return null;
      const o = entry as Record<string, unknown>;
      if (typeof o.parameter !== "string") return null;
      return {
        parameter: o.parameter,
        suggestedValue: typeof o.suggestedValue === "string" ? o.suggestedValue : String(o.suggestedValue ?? ""),
        rationale: stringOr(o.rationale, ""),
      };
    })
    .filter((x): x is Recommendation => x !== null);
}

function parseCharacterizations(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function parseComparison(v: unknown): HistoricalComparison | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.collapseName !== "string") return null;
  return {
    collapseName: o.collapseName,
    similarityScore: typeof o.similarityScore === "number" ? Math.max(0, Math.min(100, o.similarityScore)) : 0,
    reasoning: stringOr(o.reasoning, ""),
  };
}
