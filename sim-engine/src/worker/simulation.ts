import { TickController } from "../tick/tick-controller";
import { StateManager } from "../tick/state-manager";
import { AgentOrchestrator, type PreStakeProgressEvent } from "../agents/orchestrator";
import { SimDatabase } from "../db/database";
import { StablecoinMechanismController } from "../scenarios/stablecoin-controller";
import { ChainExecutor } from "../chain/action-executor";
import { computeCoordinationEdges } from "../metrics/coordination";
import type { LLMClient } from "../llm/types";
import type { SimulationConfig, AgentPersona, TickConfig, TickResult, AgentAction } from "../types";

export interface RunSimulationOptions {
  simId: string;
  config: SimulationConfig;
  agents: AgentPersona[];
  tickConfig: TickConfig;
  llm: LLMClient;
  db: SimDatabase;
  onChain?: boolean;
  /** Called once before the tick loop starts. */
  onStart?: (meta: { agentCount: number; maxTicks: number }) => void;
  /** Called at the beginning of each tick. */
  onTickStart?: (tick: number) => void;
  /** Called after every tick completes. */
  onTickComplete?: (result: TickResult) => void;
  /** Called if the run trips the death-spiral threshold. */
  onDeathSpiral?: (tick: number) => void;
  /** Called right before the function resolves. */
  onComplete?: (summary: { totalTicks: number; deathSpiralDetected: boolean; finalPrice: number; initialPrice: number }) => void;
  /** Return `true` between ticks to pause, `false` to proceed, `"abort"` to stop. */
  shouldPause?: () => Promise<false | true | "abort"> | (false | true | "abort");
  /** Called during the on-chain pre-stake phase. Worker forwards to IPC. */
  onPreStakeProgress?: (event: PreStakeProgressEvent) => void;
}

export interface RunSimulationResult {
  totalTicks: number;
  deathSpiralDetected: boolean;
  /** Tick at which the death spiral was detected, or null if it never tripped. */
  deathSpiralAtTick: number | null;
  finalPrice: number;
  initialPrice: number;
}

/**
 * Self-contained tick loop — callable from both the CLI (src/index.ts) and
 * the child-process worker (src/worker/main.ts). All I/O flows through
 * injected callbacks so we don't `console.log` inside this function.
 */
export async function runSimulation(opts: RunSimulationOptions): Promise<RunSimulationResult> {
  const { simId, config, agents, tickConfig, llm, db, onChain } = opts;

  db.createSimulation(simId, config);

  const stateManager = new StateManager(config);

  let chainExecutor: ChainExecutor | null = null;
  if (onChain) {
    chainExecutor = new ChainExecutor();
    const { reserveBase, reserveQuote } = await chainExecutor.getPrice();
    stateManager.setPoolReserves(reserveBase, reserveQuote);
  }

  const orchestrator = new AgentOrchestrator(agents, llm, stateManager, db, simId, chainExecutor);
  // Bulk pre-stake on-chain for personas with stakedFraction > 0 so their
  // stake_account PDAs exist before any agent issues a `propose` action.
  // No-op when chain or staking program isn't deployed.
  await orchestrator.init({ onProgress: opts.onPreStakeProgress });

  let stablecoinController: StablecoinMechanismController | null = null;
  if (config.stablecoin?.enabled) {
    stablecoinController = new StablecoinMechanismController(config);
  }

  const tick = new TickController({
    intervalMs: tickConfig.intervalMs,
    maxTicks: tickConfig.maxTicks,
  });

  let deathSpiralDetected = false;
  let deathSpiralAtTick: number | null = null;
  let lastCompletedTick = 0;
  // Track whether per-tick fund_reward_vault hit its first failure so we
  // log it once instead of every tick after the deployer ATA empties.
  let emissionsBroken = false;
  const initialPrice = config.amm.initialPrice;
  const recentActions: AgentAction[] = [];
  const COORDINATION_WINDOW = 5;
  const largeThreshold = config.token.totalSupply * 0.01;

  opts.onStart?.({ agentCount: agents.length, maxTicks: tickConfig.maxTicks });

  tick.on("tick:start", async ({ tick: tickNum }) => {
    const tickStart = Date.now();
    opts.onTickStart?.(tickNum);

    // If on-chain staking/governance are deployed, bump their authority-gated
    // tick counters so reward accrual + voting-period checks move in lockstep.
    if (chainExecutor && (chainExecutor.hasStaking() || chainExecutor.hasGovernance())) {
      try {
        await chainExecutor.setTick(tickNum);
      } catch (e) {
        console.error(`  chain setTick(${tickNum}) failed:`, (e as Error).message);
      }
    }

    await orchestrator.settlePendingUnstakes(tickNum);

    // Reward-vault inflation: emit fresh tokens per tick into the reward vault
    // so long-running sims don't dry up the once-seeded reward pool.
    // Amount = total_staked × rewardEmissionRate.
    // The deploy script mints an inflation budget into the deployer ATA so
    // these calls have source funds; if the budget runs out we suppress
    // further warnings (one-shot signal is enough) and let the sim continue.
    if (chainExecutor && chainExecutor.hasStaking()) {
      const dep = chainExecutor.getDeployment();
      const rate = dep.staking?.rewardEmissionRate ?? 0;
      if (rate > 0) {
        const totalStaked = stateManager.getTotalStaked();
        const emit = totalStaked * rate;
        if (emit > 0) {
          try {
            await chainExecutor.fundRewardVault(emit);
          } catch (e) {
            if (!emissionsBroken) {
              const msg = (e as Error).message;
              console.warn(`  [emissions] tick=${tickNum} fund_reward_vault failed (suppressing further): ${msg.slice(0, 250)}`);
              emissionsBroken = true;
            }
          }
        }
      }
    }

    if (chainExecutor && chainExecutor.hasStaking() && tickNum % 5 === 0) {
      await orchestrator.claimRewardsOnChain();
    }

    // Vesting: try to mint anything that just unlocked. The token-mint program
    // enforces cliff + linear unlock against `current_tick`; pre-cliff and
    // no-progress ticks are silently swallowed inside claimAllVested.
    if (chainExecutor && chainExecutor.hasVesting()) {
      try {
        const result = await chainExecutor.claimAllVested(tickNum);
        for (const claim of result.claims) {
          if (claim.txSignature) {
            console.log(`  [vesting] ${claim.allocationName} unlocked at tick ${tickNum} (${claim.txSignature.slice(0, 8)}…)`);
          } else if (claim.error) {
            console.warn(`  [vesting] ${claim.allocationName} claim failed: ${claim.error}`);
          }
        }
      } catch (e) {
        console.error(`  chain claimAllVested(${tickNum}) failed:`, (e as Error).message);
      }
    }

    // Distribute staking rewards
    const rewards = stateManager.computeStakingRewards();
    const rewardsPaid = orchestrator.applyStakingRewards(rewards);

    const agentBalances = orchestrator.getAgentBalances();
    const state = await stateManager.readState(tickNum, agentBalances);
    state.rewardsPaidThisTick = rewardsPaid;

    if (stablecoinController) {
      const r = stablecoinController.processTick(state);
      state.stablecoinSupply = r.stablecoinSupply;
      state.reserveBalance = r.reserveBalance;
      state.pegPrice = r.pegPrice;
      state.initialReserveBalance = r.initialReserve;
      state.reserveDrainedThisTick = r.reserveDrainedThisTick;
      state.yieldPaidThisTick = r.yieldPaid;
      state.borrowerRevenueThisTick = r.borrowerRevenue;
      if (r.baseMinted > 0) {
        stateManager.inflateSupply(r.baseMinted);
        state.totalSupply += r.baseMinted;
        stateManager.executeSwap(r.baseMinted, true);
        state.tokenPrice = stateManager.getPrice();
        state.priceHistory = [...state.priceHistory.slice(0, -1), state.tokenPrice];
      }
    }

    const actions = await orchestrator.processTickBatch(state);

    // Track recent actions for coordination detection (sliding window).
    recentActions.push(...actions);
    const cutoffTick = tickNum - COORDINATION_WINDOW + 1;
    while (recentActions.length > 0 && recentActions[0].tick < cutoffTick) {
      recentActions.shift();
    }
    state.coordinationEdges = computeCoordinationEdges(recentActions, tickNum, {
      windowTicks: COORDINATION_WINDOW,
      largeAmountThreshold: largeThreshold,
      minCoOccurrences: 2,
    });

    const currentPrice = stateManager.getPrice();
    if (currentPrice < initialPrice * 0.01 && !deathSpiralDetected) {
      deathSpiralDetected = true;
      deathSpiralAtTick = tickNum;
      db.updateSimStatus(simId, "death_spiral");
      opts.onDeathSpiral?.(tickNum);
    }

    const elapsed = Date.now() - tickStart;
    db.insertTickState(simId, tickNum, state, elapsed);
    lastCompletedTick = tickNum;

    const result: TickResult = { tick: tickNum, actions, stateAfter: state, duration_ms: elapsed };
    opts.onTickComplete?.(result);
    tick.markTickComplete(result);

    // Cooperative pause/abort between ticks
    if (opts.shouldPause) {
      const sig = await Promise.resolve(opts.shouldPause());
      if (sig === "abort") tick.stop();
      else if (sig === true) {
        // Spin until resumed or aborted
        while (true) {
          const next = await Promise.resolve(opts.shouldPause());
          if (next === "abort") { tick.stop(); break; }
          if (next === false) break;
          await Bun.sleep(250);
        }
      }
    }
  });

  const results = await tick.start();
  const finalPrice = stateManager.getPrice();

  if (!deathSpiralDetected) {
    db.updateSimStatus(simId, "completed");
  }
  db.updateSimTicks(simId, results.length);

  const summary: RunSimulationResult = {
    totalTicks: results.length,
    deathSpiralDetected,
    deathSpiralAtTick,
    finalPrice,
    initialPrice,
  };
  opts.onComplete?.(summary);
  return summary;
}
