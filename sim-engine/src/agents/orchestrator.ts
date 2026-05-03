import type {
  AgentPersona,
  AgentState,
  AgentAction,
  SimulationState,
  LLMResponse,
  ActionType,
} from "../types";
import type { LLMClient, LLMBatchItem } from "../llm/types";
import { buildAgentPrompt } from "../llm/prompt-builder";
import { StateManager } from "../tick/state-manager";
import { SimDatabase } from "../db/database";
import type { ChainExecutor } from "../chain/action-executor";
import { InMemoryStore, type MemoryStore } from "./memory";
import {
  resolveVisibility,
  orderAgentsForObservation,
  DEFAULT_VISIBILITY_RULES,
  DEFAULT_TARGET_RULES,
  type VisibilityRule,
} from "./visibility";

/**
 * Progress event emitted by `AgentOrchestrator.init()` during the on-chain
 * pre-stake phase. Worker forwards these to the IPC event stream so the UI
 * can render a per-tick progress bar instead of dead air at status=running,
 * tick=0.
 */
export type PreStakeProgressEvent =
  | { phase: "start"; total: number }
  | { phase: "tick"; agentId: string; current: number; total: number; succeeded: number; failed: number }
  | { phase: "complete"; total: number; succeeded: number; failed: number; durationMs: number };

export class AgentOrchestrator {
  private agents: Map<string, AgentState> = new Map();
  /** Deterministic batch order used each tick (treasury → ... → insider → analyst). */
  private orderedPersonaIds: string[] = [];
  private llm: LLMClient;
  private stateManager: StateManager;
  private db: SimDatabase;
  private simId: string;
  private chain: ChainExecutor | null;
  private memory: MemoryStore;
  private visibilityRules: VisibilityRule[];
  private targetRules: Record<string, { delay: number; fidelity: number }>;
  private pendingUnstakes: Map<string, { amount: number; readyTick: number; requestTx: string }> = new Map();
  /**
   * Map of localProposalId → { chainProposalId, txSig }.
   * Voters skip the chain attempt when a local proposal has no entry —
   * prevents `proposal not initialized` cascades when chain.createProposal
   * fails but the local mirror succeeded.
   */
  private chainProposals: Map<number, { chainProposalId: number; proposerId: string; txSig: string }> = new Map();

  constructor(
    personas: AgentPersona[],
    llm: LLMClient,
    stateManager: StateManager,
    db: SimDatabase,
    simId: string,
    chain: ChainExecutor | null = null,
    memory: MemoryStore = new InMemoryStore(),
    visibilityRules: VisibilityRule[] = DEFAULT_VISIBILITY_RULES,
    targetRules: Record<string, { delay: number; fidelity: number }> = DEFAULT_TARGET_RULES,
  ) {
    this.memory = memory;
    this.llm = llm;
    this.stateManager = stateManager;
    this.db = db;
    this.simId = simId;
    this.chain = chain;
    this.visibilityRules = visibilityRules;
    this.targetRules = targetRules;

    this.orderedPersonaIds = orderAgentsForObservation(personas).map((p) => p.id);

    // Initialize agent states from personas.
    // Personas can specify `stakedFraction` to start with tokens already
    // staked, which lets extracted staking-heavy protocols begin under load.
    for (const persona of personas) {
      const totalTokens = persona.initialCapital.token;
      const frac = Math.max(0, Math.min(1, persona.initialCapital.stakedFraction ?? 0));
      const staked = Math.floor(totalTokens * frac);
      const liquid = totalTokens - staked;

      this.agents.set(persona.id, {
        persona,
        walletAddress: persona.id, // Simplified for Phase 1
        holdings: {
          token: liquid,
          staked,
          usdc: persona.initialCapital.usdc,
        },
        memory: [],
        observedActions: [],
      });

      if (staked > 0) {
        // For veToken protocols, initial stake commits to max lock by default
        // — matches the typical Curve "lock everything for max boost" model.
        // Personas can still unstake liquid tokens; they just can't unwind
        // the staked half until the lock expires.
        this.stateManager.stake(persona.id, staked, this.defaultLockTicks());
      }
    }
  }

  /**
   * Default lock duration when an agent stakes via a `stake` action. Returns
   * undefined for non-veToken protocols (no-op in StateManager.stake).
   */
  private defaultLockTicks(): number | undefined {
    const ve = this.stateManager.getConfig().veToken;
    if (ve?.enabled) return ve.maxLockMonths * 30;
    return undefined;
  }

  /**
   * Bulk-stake on-chain for every persona that arrived with `stakedFraction > 0`.
   * Each call hits initializeStakeAccount + stake (two txs). At 91 agents ×
   * 50% pre-staked that's ~90 txs; concurrency 20 finishes in ~5s on localnet.
   *
   * `onProgress` is called once when work starts ({ phase: "start" }), once
   * per completed agent ({ phase: "tick", current, total, succeeded, failed }),
   * and once when finished ({ phase: "complete", … }). The worker hooks this
   * up to an IPC event so the UI can render "pre-staking 49/84…" instead of
   * a 5-second silence.
   */
  async init(opts?: {
    onProgress?: (event: PreStakeProgressEvent) => void;
  }): Promise<void> {
    if (!this.chain || !this.chain.hasStaking()) return;
    const toStake: { agentId: string; amount: number }[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.holdings.staked > 0 && this.chain.hasAgent(id)) {
        toStake.push({ agentId: id, amount: agent.holdings.staked });
      }
    }
    if (toStake.length === 0) return;

    console.log(`[orchestrator] pre-staking ${toStake.length} agents on-chain…`);
    opts?.onProgress?.({ phase: "start", total: toStake.length });
    const t0 = Date.now();
    const concurrency = Math.max(1, Math.min(toStake.length, Number(process.env.SIM_PRESTAKE_CONCURRENCY) || 20));
    let cursor = 0;
    let succeeded = 0;
    let failed = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        for (;;) {
          const i = cursor++;
          if (i >= toStake.length) return;
          const { agentId, amount } = toStake[i]!;
          try {
            await this.chain!.stake(agentId, amount);
            succeeded++;
          } catch (e) {
            failed++;
            const err = e as Error;
            const msg = err.message ?? String(err);
            const stack0 = (err.stack ?? "").split("\n").find((l) => l.includes(".ts:") || l.includes(".js:")) ?? "";
            console.warn(`  [pre-stake] ${agentId} (${amount}) failed: ${msg.slice(0, 400)}\n    at ${stack0.trim()}`);
          }
          opts?.onProgress?.({
            phase: "tick",
            agentId,
            current: succeeded + failed,
            total: toStake.length,
            succeeded,
            failed,
          });
        }
      })());
    }
    await Promise.all(workers);
    const durationMs = Date.now() - t0;
    console.log(`[orchestrator] pre-staked ${succeeded}/${toStake.length} agents in ${durationMs}ms (${failed} failed)`);
    opts?.onProgress?.({
      phase: "complete",
      total: toStake.length,
      succeeded,
      failed,
      durationMs,
    });
  }

  /**
   * Apply per-tick staking rewards computed by the StateManager.
   * Reward tokens accrue to each agent's staked balance.
   * Returns total rewards paid (for prompt surfacing).
   */
  applyStakingRewards(rewards: Map<string, number>): number {
    let total = 0;
    for (const [agentId, reward] of rewards) {
      if (reward <= 0) continue;
      const agent = this.agents.get(agentId);
      if (!agent) continue;
      agent.holdings.staked += reward;
      this.stateManager.stake(agentId, reward);
      total += reward;
    }
    return total;
  }

  /**
   * Complete on-chain unstakes whose cooldown has expired. The request side
   * happens when an agent chooses `unstake`; this settlement side runs at the
   * start of later ticks after ChainExecutor.setTick().
   */
  async settlePendingUnstakes(tick: number): Promise<void> {
    if (!this.chain || !this.chain.hasStaking()) return;
    for (const [agentId, pending] of [...this.pendingUnstakes.entries()]) {
      if (tick < pending.readyTick) continue;
      const agent = this.agents.get(agentId);
      if (!agent) {
        this.pendingUnstakes.delete(agentId);
        continue;
      }
      try {
        await this.chain.completeUnstake(agentId);
        const balances = await this.chain.getAgentBalances(agentId);
        agent.holdings.token = balances.base;
        agent.holdings.usdc = balances.quote;
        this.pendingUnstakes.delete(agentId);
      } catch (e) {
        console.warn(`  chain complete_unstake failed for ${agentId}:`, (e as Error).message.slice(0, 160));
      }
    }
  }

  /** Best-effort reward claims for agents with active on-chain stake accounts. */
  async claimRewardsOnChain(): Promise<void> {
    if (!this.chain || !this.chain.hasStaking()) return;
    for (const [agentId, agent] of this.agents) {
      if (agent.holdings.staked <= 0) continue;
      try {
        await this.chain.claimRewards(agentId);
        const balances = await this.chain.getAgentBalances(agentId);
        agent.holdings.token = balances.base;
        agent.holdings.usdc = balances.quote;
      } catch {
        // NoRewards / RewardVaultEmpty are expected on quiet ticks; keep claims best-effort.
      }
    }
  }

  /**
   * Process all agents for a single tick.
   * Agents run in parallel batches. Batch order is deterministic so
   * visibility rules (insider sees treasury this tick, analyst publishes
   * next tick) hold without race conditions across LLM latency.
   */
  async processTickBatch(
    sim: SimulationState,
    // 12 is a comfortable concurrency for OpenRouter — empirically a 50-agent
    // tick now lands in ~12s instead of ~130s. If your provider rate-limits
    // hard, drop this back to 3-5. Configurable via SIM_BATCH_SIZE env var
    // when set; otherwise falls back to this default.
    batchSize: number = Math.max(1, Number(process.env.SIM_BATCH_SIZE) || 12)
  ): Promise<AgentAction[]> {
    // Drain any delayed observations whose visibility tick has arrived.
    this.memory.advanceTick(sim.tick);

    const agentList = this.orderedPersonaIds
      .map((id) => this.agents.get(id))
      .filter((a): a is AgentState => !!a);
    const allActions: AgentAction[] = [];

    for (let i = 0; i < agentList.length; i += batchSize) {
      const batch = agentList.slice(i, i + batchSize);

      // Build prompts for this batch, tagged with complexity for boost routing
      const prompts: LLMBatchItem[] = batch.map((agent) => ({
        agentId: agent.persona.id,
        prompt: buildAgentPrompt(agent, sim),
        complexity: agent.persona.complexity ?? "standard",
      }));

      // Run LLM calls in parallel
      const responses = await this.llm.generateBatch(prompts);

      // Process each response
      for (const agent of batch) {
        const llmResponse = responses.get(agent.persona.id) || {
          action: "hold" as ActionType,
          amount: null,
          reasoning: "no_response",
          threat_assessment: "none",
        };

        // Validate and execute
        const validated = this.validateAction(agent, llmResponse);
        const action = await this.executeAction(agent, validated, sim);
        allActions.push(action);

        // Update agent memory via the store (single source of truth)
        this.memory.recordAction(agent.persona.id, action);
        agent.memory = this.memory.getRecentActions(agent.persona.id, 20);

        // Persist to DB
        this.db.insertAction(this.simId, action);
        this.db.insertAgentState(this.simId, sim.tick, agent.persona.id, agent.holdings);
      }

      // Update observed actions for subsequent batches, honoring visibility rules.
      for (const action of allActions.slice(-batch.length)) {
        if (action.action === "hold") continue;
        for (const observer of agentList) {
          if (observer.persona.id === action.agentId) continue;
          const { delay, fidelity, action: shaped } = resolveVisibility(
            observer.persona.id,
            action,
            this.visibilityRules,
            this.targetRules,
          );
          this.memory.recordObservation(observer.persona.id, shaped, { delay, fidelity });
          observer.observedActions = this.memory.getRecentObservations(observer.persona.id, 10);
        }
      }
    }

    return allActions;
  }

  /**
   * Get current balances for all agents (for StateManager).
   */
  getAgentBalances(): Map<string, { token: number; staked: number; usdc: number }> {
    const balances = new Map<string, { token: number; staked: number; usdc: number }>();
    for (const [id, agent] of this.agents) {
      balances.set(id, { ...agent.holdings });
    }
    return balances;
  }

  private validateAction(agent: AgentState, response: LLMResponse): LLMResponse {
    const validated = { ...response };

    switch (validated.action) {
      case "sell":
        if (validated.amount !== null) {
          validated.amount = Math.min(validated.amount, agent.holdings.token);
          if (validated.amount <= 0) {
            validated.action = "hold";
            validated.reasoning = "wanted to sell but no tokens to sell";
          }
        }
        break;

      case "buy":
        if (validated.amount !== null) {
          validated.amount = Math.min(validated.amount, agent.holdings.usdc);
          if (validated.amount <= 0) {
            validated.action = "hold";
            validated.reasoning = "wanted to buy but no USDC";
          }
        }
        break;

      case "unstake":
        if (validated.amount !== null) {
          validated.amount = Math.min(validated.amount, agent.holdings.staked);
          if (validated.amount <= 0) {
            validated.action = "hold";
            validated.reasoning = "wanted to unstake but nothing staked";
          }
        }
        break;

      case "stake":
        if (validated.amount !== null) {
          validated.amount = Math.min(validated.amount, agent.holdings.token);
          if (validated.amount <= 0) {
            validated.action = "hold";
            validated.reasoning = "wanted to stake but no tokens";
          }
        }
        break;

      case "burn_stablecoin":
        if (validated.amount !== null && validated.amount <= 0) {
          validated.action = "hold";
          validated.reasoning = "invalid burn amount";
        }
        break;
    }

    return validated;
  }

  /**
   * Execute an agent's decision using the StateManager's simulated AMM.
   */
  private async executeAction(
    agent: AgentState,
    decision: LLMResponse,
    sim: SimulationState
  ): Promise<AgentAction> {
    let success = true;

    switch (decision.action) {
      case "buy": {
        // Swap USDC → Token
        const usdcToSpend = decision.amount || 0;
        if (usdcToSpend > 0 && usdcToSpend <= agent.holdings.usdc) {
          if (this.chain && this.chain.hasAgent(agent.persona.id)) {
            try {
              const result = await this.chain.swap(agent.persona.id, "buy", usdcToSpend);
              const balances = await this.chain.getAgentBalances(agent.persona.id);
              agent.holdings.token = balances.base;
              agent.holdings.usdc = balances.quote;
              const { reserveBase, reserveQuote } = await this.chain.getPrice();
              this.stateManager.setPoolReserves(reserveBase, reserveQuote);
              this.stateManager.recordTrade(agent.persona.id, "buy", usdcToSpend);
              return this.buildAction(agent, decision, sim, true, result.txSignature);
            } catch (e) {
              console.error(`  chain buy failed for ${agent.persona.id}:`, (e as Error).message);
              success = false;
            }
          } else {
            const tokensReceived = this.stateManager.executeSwap(usdcToSpend, false);
            if (tokensReceived > 0) {
              agent.holdings.usdc -= usdcToSpend;
              agent.holdings.token += tokensReceived;
              this.stateManager.recordTrade(agent.persona.id, "buy", usdcToSpend);
            } else {
              success = false;
            }
          }
        } else {
          success = false;
        }
        break;
      }

      case "sell": {
        // Swap Token → USDC
        const tokensToSell = decision.amount || 0;
        if (tokensToSell > 0 && tokensToSell <= agent.holdings.token) {
          if (this.chain && this.chain.hasAgent(agent.persona.id)) {
            try {
              const result = await this.chain.swap(agent.persona.id, "sell", tokensToSell);
              const balances = await this.chain.getAgentBalances(agent.persona.id);
              agent.holdings.token = balances.base;
              agent.holdings.usdc = balances.quote;
              const { reserveBase, reserveQuote } = await this.chain.getPrice();
              this.stateManager.setPoolReserves(reserveBase, reserveQuote);
              this.stateManager.recordTrade(agent.persona.id, "sell", tokensToSell);
              return this.buildAction(agent, decision, sim, true, result.txSignature);
            } catch (e) {
              console.error(`  chain sell failed for ${agent.persona.id}:`, (e as Error).message);
              success = false;
            }
          } else {
            const usdcReceived = this.stateManager.executeSwap(tokensToSell, true);
            if (usdcReceived > 0) {
              agent.holdings.token -= tokensToSell;
              agent.holdings.usdc += usdcReceived;
              this.stateManager.recordTrade(agent.persona.id, "sell", tokensToSell);
            } else {
              success = false;
            }
          }
        } else {
          success = false;
        }
        break;
      }

      case "stake": {
        const toStake = decision.amount || 0;
        if (toStake > 0 && toStake <= agent.holdings.token) {
          let stakeTx: string | null = null;
          if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasStaking()) {
            try {
              const r = await this.chain.stake(agent.persona.id, toStake);
              stakeTx = r.txSignature;
            } catch (e) {
              console.error(`  chain stake failed for ${agent.persona.id}:`, (e as Error).message.slice(0, 120));
              success = false;
              break;
            }
          }
          agent.holdings.token -= toStake;
          agent.holdings.staked += toStake;
          this.stateManager.stake(agent.persona.id, toStake, this.defaultLockTicks());
          this.stateManager.recordTrade(agent.persona.id, "stake", toStake);
          return this.buildAction(agent, decision, sim, true, stakeTx);
        } else {
          success = false;
        }
        break;
      }

      case "unstake": {
        const toUnstake = decision.amount || 0;
        if (toUnstake > 0) {
          if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasStaking()) {
            if (!this.stateManager.canUnstake(agent.persona.id)) {
              success = false;
              break;
            }
            try {
              const requested = await this.chain.requestUnstake(agent.persona.id, toUnstake);
              const actual = this.stateManager.unstake(agent.persona.id, toUnstake);
              if (actual <= 0) {
                success = false;
                break;
              }
              agent.holdings.staked -= actual;
              const cooldown = this.chain.getDeployment().staking?.unstakeCooldownTicks ?? 0;
              if (cooldown <= 0) {
                await this.chain.completeUnstake(agent.persona.id);
                const balances = await this.chain.getAgentBalances(agent.persona.id);
                agent.holdings.token = balances.base;
                agent.holdings.usdc = balances.quote;
              } else {
                this.pendingUnstakes.set(agent.persona.id, {
                  amount: actual,
                  readyTick: sim.tick + cooldown,
                  requestTx: requested.txSignature,
                });
              }
              this.stateManager.recordTrade(agent.persona.id, "unstake", actual);
              return this.buildAction(agent, decision, sim, true, requested.txSignature);
            } catch (e) {
              console.error(`  chain unstake failed for ${agent.persona.id}:`, (e as Error).message.slice(0, 160));
              success = false;
              break;
            }
          }
          const actual = this.stateManager.unstake(agent.persona.id, toUnstake);
          if (actual > 0) {
            agent.holdings.staked -= actual;
            agent.holdings.token += actual;
            this.stateManager.recordTrade(agent.persona.id, "unstake", actual);
          } else {
            success = false;
          }
        } else {
          success = false;
        }
        break;
      }

      case "propose": {
        const description = (decision.reasoning || "proposal").slice(0, 63);
        const proposal = this.stateManager.createProposal(agent.persona.id, description);
        if (!proposal) {
          success = false;
          break;
        }
        let txSig: string | null = null;
        let chainOk = true;
        if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasGovernance()) {
          try {
            const r = await this.chain.createProposal(agent.persona.id, proposal.id, description);
            txSig = r.txSignature;
            this.chainProposals.set(proposal.id, {
              chainProposalId: r.proposalId,
              proposerId: agent.persona.id,
              txSig: r.txSignature,
            });
          } catch (e) {
            console.error(`  chain propose failed for ${agent.persona.id}:`, (e as Error).message.slice(0, 120));
            // Roll back the local proposal so the next voter doesn't target a
            // proposal that doesn't exist on-chain. Chain + local stay aligned.
            this.stateManager.removeProposal(proposal.id);
            chainOk = false;
          }
        }
        if (!chainOk) {
          return this.buildAction(agent, decision, sim, false, null);
        }
        this.stateManager.recordTrade(agent.persona.id, "propose", proposal.id);
        return this.buildAction(agent, decision, sim, true, txSig);
      }

      case "vote_yes":
      case "vote_no": {
        const support = decision.action === "vote_yes";
        const explicitId = decision.amount != null ? Math.floor(decision.amount) : null;
        const latest = this.stateManager.getLatestActiveProposalId();
        const proposalId = explicitId != null && explicitId >= 0 ? explicitId : latest;
        if (proposalId == null) {
          success = false;
          break;
        }
        const voted = this.stateManager.castVote(agent.persona.id, proposalId, support);
        if (!voted) {
          success = false;
          break;
        }
        let txSig: string | null = null;
        // Only attempt the on-chain vote when the proposal actually exists
        // on chain. Local-only proposals (chain.createProposal failed earlier)
        // are still valid governance signal in the simulation but must not
        // be sent to the program.
        const hasChainProposal = this.chainProposals.has(proposalId);
        if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasGovernance() && hasChainProposal) {
          try {
            const r = await this.chain.castVote(agent.persona.id, proposalId, support);
            txSig = r.txSignature;
          } catch (e) {
            console.error(`  chain vote failed for ${agent.persona.id}:`, (e as Error).message.slice(0, 120));
          }
        }
        this.stateManager.recordTrade(agent.persona.id, decision.action, proposalId);
        return this.buildAction(agent, decision, sim, true, txSig);
      }

      case "hold":
        // No action needed
        break;

      default:
        // Unknown action, treat as hold
        break;
    }

    return this.buildAction(agent, decision, sim, success, null);
  }

  private buildAction(
    agent: AgentState,
    decision: LLMResponse,
    sim: SimulationState,
    success: boolean,
    txSignature: string | null,
  ): AgentAction {
    return {
      tick: sim.tick,
      agentId: agent.persona.id,
      action: decision.action,
      amount: decision.amount,
      reasoning: decision.reasoning,
      threatAssessment: decision.threat_assessment,
      txSignature,
      success,
      timestamp: Date.now(),
    };
  }
}
