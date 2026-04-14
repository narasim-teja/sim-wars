import type {
  AgentPersona,
  AgentState,
  AgentAction,
  SimulationState,
  LLMResponse,
  ActionType,
} from "../types";
import { OllamaClient } from "../llm/ollama-client";
import { buildAgentPrompt } from "../llm/prompt-builder";
import { StateManager } from "../tick/state-manager";
import { SimDatabase } from "../db/database";
import type { ChainExecutor } from "../chain/action-executor";

export class AgentOrchestrator {
  private agents: Map<string, AgentState> = new Map();
  private llm: OllamaClient;
  private stateManager: StateManager;
  private db: SimDatabase;
  private simId: string;
  private chain: ChainExecutor | null;

  constructor(
    personas: AgentPersona[],
    llm: OllamaClient,
    stateManager: StateManager,
    db: SimDatabase,
    simId: string,
    chain: ChainExecutor | null = null
  ) {
    this.llm = llm;
    this.stateManager = stateManager;
    this.db = db;
    this.simId = simId;
    this.chain = chain;

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
        this.stateManager.stake(persona.id, staked);
      }
    }
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
   * Agents run in parallel batches.
   */
  async processTickBatch(
    sim: SimulationState,
    batchSize: number = 3
  ): Promise<AgentAction[]> {
    const agentList = Array.from(this.agents.values());
    const allActions: AgentAction[] = [];

    for (let i = 0; i < agentList.length; i += batchSize) {
      const batch = agentList.slice(i, i + batchSize);

      // Build prompts for this batch
      const prompts = batch.map((agent) => ({
        agentId: agent.persona.id,
        prompt: buildAgentPrompt(agent, sim),
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

        // Update agent memory
        agent.memory.push(action);
        if (agent.memory.length > 20) {
          agent.memory = agent.memory.slice(-20);
        }

        // Persist to DB
        this.db.insertAction(this.simId, action);
        this.db.insertAgentState(this.simId, sim.tick, agent.persona.id, agent.holdings);
      }

      // Update observed actions for subsequent batches
      for (const action of allActions.slice(-batch.length)) {
        if (action.action !== "hold") {
          for (const agent of agentList) {
            if (agent.persona.id !== action.agentId) {
              agent.observedActions.push(action);
              if (agent.observedActions.length > 10) {
                agent.observedActions = agent.observedActions.slice(-10);
              }
            }
          }
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
          this.stateManager.stake(agent.persona.id, toStake);
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
