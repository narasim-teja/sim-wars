import { TickController } from "./tick/tick-controller";
import { StateManager } from "./tick/state-manager";
import { AgentOrchestrator } from "./agents/orchestrator";
import { OllamaClient } from "./llm/ollama-client";
import { SimDatabase } from "./db/database";
import { LunaScenarioController } from "./scenarios/luna-controller";
import type { SimulationConfig, AgentPersona, TickConfig, SimulationState } from "./types";

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    TOKENOMICS WAR GAME — Simulation Engine  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // 1. Load scenario
  const scenarioPath = process.argv[2] || "../scenarios/luna-ust.ts";
  console.log(`Loading scenario: ${scenarioPath}`);

  let config: SimulationConfig;
  let agents: AgentPersona[];
  let tickConfig: TickConfig;

  try {
    const scenario = await import(scenarioPath);
    config = scenario.config || scenario.default?.config;
    agents = scenario.agents || scenario.default?.agents;
    tickConfig = scenario.tickConfig || scenario.default?.tickConfig;

    if (!config || !agents || !tickConfig) {
      throw new Error("Scenario must export { config, agents, tickConfig }");
    }
  } catch (error) {
    console.error(`Failed to load scenario: ${error}`);
    process.exit(1);
  }

  console.log(`  Token supply: ${config.token.totalSupply.toLocaleString()}`);
  console.log(`  Staking APY: ${config.staking.baseAPY}%`);
  console.log(`  Initial price: $${config.amm.initialPrice}`);
  console.log(`  Agents: ${agents.length}`);
  console.log(`  Max ticks: ${tickConfig.maxTicks}`);
  console.log(`  Tick interval: ${tickConfig.intervalMs}ms\n`);

  // 2. Check Ollama
  const llm = new OllamaClient("qwen3:8b");
  const ollamaHealthy = await llm.healthCheck();
  if (!ollamaHealthy) {
    console.error("ERROR: Ollama is not running. Start with: ollama serve");
    console.error("Then pull the model: ollama pull qwen3:8b");
    process.exit(1);
  }
  const models = await llm.listModels();
  console.log(`Ollama connected. Available models: ${models.join(", ")}\n`);

  // 3. Initialize database
  const db = new SimDatabase();
  const simId = crypto.randomUUID();
  db.createSimulation(simId, config);
  console.log(`Simulation ID: ${simId}`);

  // 4. Initialize components
  const stateManager = new StateManager(config);
  const orchestrator = new AgentOrchestrator(agents, llm, stateManager, db, simId);

  // 5. Initialize LUNA scenario controller (if stablecoin enabled)
  let lunaController: LunaScenarioController | null = null;
  if (config.stablecoin?.enabled) {
    lunaController = new LunaScenarioController(config);
    console.log("LUNA/UST scenario controller activated");
    console.log(`  Reserve: $${config.stablecoin.reserveAmount.toLocaleString()}`);
    console.log(`  Stablecoin peg target: $${config.stablecoin.targetPeg}\n`);
  }

  // 6. Create tick controller
  const tick = new TickController({
    intervalMs: tickConfig.intervalMs,
    maxTicks: tickConfig.maxTicks,
  });

  // Track death spiral detection
  let deathSpiralDetected = false;
  const initialPrice = config.amm.initialPrice;

  // 7. Wire up tick pipeline
  tick.on("tick:start", async ({ tick: tickNum }) => {
    const tickStart = Date.now();

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  TICK ${tickNum}`);
    console.log(`${"─".repeat(60)}`);

    // A2: distribute staking rewards BEFORE reading state so agents see the balance growth.
    const rewards = stateManager.computeStakingRewards();
    const rewardsPaid = orchestrator.applyStakingRewards(rewards);

    // Read current state
    const agentBalances = orchestrator.getAgentBalances();
    const state = await stateManager.readState(tickNum, agentBalances);
    state.rewardsPaidThisTick = rewardsPaid;

    // Apply LUNA-specific mechanics
    if (lunaController) {
      const lunaResult = lunaController.processTick(state);

      // Inject LUNA state into simulation state
      state.stablecoinSupply = lunaResult.ustSupply;
      state.reserveBalance = lunaResult.reserveBalance;
      state.pegPrice = lunaResult.pegPrice;
      state.initialReserveBalance = lunaResult.initialReserve;
      state.reserveDrainedThisTick = lunaResult.reserveDrainedThisTick;
      state.yieldPaidThisTick = lunaResult.yieldPaid;
      state.borrowerRevenueThisTick = lunaResult.borrowerRevenue;

      // Apply hyperinflation (mint new tokens from burn) AND dump them into the AMM
      // to fulfill UST redemptions — this is what actually broke LUNA's price.
      // Minted tokens are immediately sold for USDC, driving the AMM price down.
      if (lunaResult.lunaMinted > 0) {
        stateManager.inflateSupply(lunaResult.lunaMinted);
        state.totalSupply += lunaResult.lunaMinted;
        const usdcFromDump = stateManager.executeSwap(lunaResult.lunaMinted, true);
        console.log(
          `  ⚠ LUNA MINTED + DUMPED: ${lunaResult.lunaMinted.toLocaleString()} tokens → $${Math.round(usdcFromDump).toLocaleString()} USDC (hyperinflation)`
        );
      }

      // Status indicators
      const reservePct = (
        (lunaResult.reserveBalance / (config.stablecoin?.reserveAmount ?? 1)) *
        100
      ).toFixed(1);

      console.log(
        `  Reserve: $${lunaResult.reserveBalance.toLocaleString()} (${reservePct}%) | ` +
        `UST Peg: $${lunaResult.pegPrice.toFixed(4)} | ` +
        `Yield sustainable: ${lunaResult.yieldSustainable ? "YES" : "NO"}`
      );

      if (lunaResult.reserveWarning) {
        console.log("  ⚠ RESERVE WARNING: Below 30% of initial reserve");
      }
    }

    // Print market state
    console.log(
      `  Price: $${state.tokenPrice.toFixed(4)} | ` +
      `Gini: ${state.giniCoefficient.toFixed(3)} | ` +
      `Staked: ${((state.stakedSupply / state.totalSupply) * 100).toFixed(1)}% | ` +
      `Supply: ${state.totalSupply.toLocaleString()}`
    );

    // Process agents
    console.log("\n  Agent Decisions:");
    const actions = await orchestrator.processTickBatch(state);

    for (const a of actions) {
      const status = a.success ? "✓" : "✗";
      const amountStr = a.amount !== null ? ` ${a.amount.toLocaleString()}` : "";
      console.log(
        `  [${status}] ${a.agentId.padEnd(12)} ${a.action.padEnd(10)}${amountStr}`
      );
      console.log(`      Reasoning: "${a.reasoning}"`);
      if (a.threatAssessment && a.threatAssessment !== "none") {
        console.log(`      Threat: "${a.threatAssessment}"`);
      }
    }

    // Death spiral detection
    const currentPrice = stateManager.getPrice();
    if (currentPrice < initialPrice * 0.01 && !deathSpiralDetected) {
      deathSpiralDetected = true;
      console.log("\n  ╔═══════════════════════════════════════╗");
      console.log("  ║     💀 DEATH SPIRAL DETECTED 💀       ║");
      console.log("  ╚═══════════════════════════════════════╝");
      db.updateSimStatus(simId, "death_spiral");
    }

    const elapsed = Date.now() - tickStart;

    // Persist tick state
    db.insertTickState(simId, tickNum, state, elapsed);

    console.log(`\n  Tick ${tickNum} completed in ${elapsed}ms`);

    // Signal completion
    tick.markTickComplete({
      tick: tickNum,
      actions,
      stateAfter: state,
      duration_ms: elapsed,
    });
  });

  // 8. Start simulation
  console.log("\n" + "═".repeat(60));
  console.log("  SIMULATION STARTING");
  console.log("═".repeat(60));

  const results = await tick.start();

  // 9. Summary
  console.log("\n" + "═".repeat(60));
  console.log("  SIMULATION COMPLETE");
  console.log("═".repeat(60));

  const finalPrice = stateManager.getPrice();
  const priceChange = ((finalPrice - initialPrice) / initialPrice * 100).toFixed(2);

  console.log(`  Total ticks: ${results.length}`);
  console.log(`  Initial price: $${initialPrice}`);
  console.log(`  Final price: $${finalPrice.toFixed(4)} (${priceChange}%)`);
  console.log(`  Death spiral: ${deathSpiralDetected ? "YES" : "NO"}`);

  if (lunaController) {
    console.log(`  Final reserve: $${lunaController.getReserveBalance().toLocaleString()}`);
    console.log(`  Final UST supply: ${lunaController.getUstSupply().toLocaleString()}`);
  }

  // Update simulation status
  if (!deathSpiralDetected) {
    db.updateSimStatus(simId, "completed");
  }
  db.updateSimTicks(simId, results.length);

  console.log(`\n  Simulation data saved to sim-data.sqlite (ID: ${simId})`);
  db.close();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
