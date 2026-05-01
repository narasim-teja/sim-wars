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
    // A1: personas can specify `stakedFraction` to start with tokens already staked,
    // which kickstarts the LUNA reserve drain (Anchor Protocol reality at peak).
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
   * Process all agents for a single tick.
   * Agents run in parallel batches. Batch order is deterministic so
   * visibility rules (insider sees treasury this tick, analyst publishes
   * next tick) hold without race conditions across LLM latency.
   */
  async processTickBatch(
    sim: SimulationState,
    batchSize: number = 3
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
              agent.holdings.token = balances.luna;
              agent.holdings.usdc = balances.ust;
              const { reserveLuna, reserveUst } = await this.chain.getPrice();
              this.stateManager.setPoolReserves(reserveLuna, reserveUst);
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
              agent.holdings.token = balances.luna;
              agent.holdings.usdc = balances.ust;
              const { reserveLuna, reserveUst } = await this.chain.getPrice();
              this.stateManager.setPoolReserves(reserveLuna, reserveUst);
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
          agent.holdings.token -= toStake;
          agent.holdings.staked += toStake;
          // veToken protocols: apply max-lock by default. The lock map only
          // grows: existing locks aren't shortened by additional stakes.
          this.stateManager.stake(agent.persona.id, toStake, this.defaultLockTicks());
          this.stateManager.recordTrade(agent.persona.id, "stake", toStake);
        } else {
          success = false;
        }
        break;
      }

      case "unstake": {
        const toUnstake = decision.amount || 0;
        if (toUnstake > 0) {
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
        // Descriptions come out of the LLM's reasoning — keep the first sentence
        // so the on-chain [u8; 64] field isn't overrun.
        const description = (decision.reasoning || "proposal").slice(0, 63);
        const proposal = this.stateManager.createProposal(agent.persona.id, description);
        if (!proposal) {
          success = false;
          break;
        }
        let txSig: string | null = null;
        if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasGovernance()) {
          try {
            const r = await this.chain.createProposal(agent.persona.id, proposal.id, description);
            txSig = r.txSignature;
          } catch (e) {
            console.error(`  chain propose failed for ${agent.persona.id}:`, (e as Error).message);
            // Keep local proposal; chain side will drift — flag for next sync.
          }
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
        if (this.chain && this.chain.hasAgent(agent.persona.id) && this.chain.hasGovernance()) {
          try {
            const r = await this.chain.castVote(agent.persona.id, proposalId, support);
            txSig = r.txSignature;
          } catch (e) {
            console.error(`  chain vote failed for ${agent.persona.id}:`, (e as Error).message);
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
