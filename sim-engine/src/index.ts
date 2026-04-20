import { SimDatabase } from "./db/database";
import { buildLLMClient } from "./llm/factory";
import { runSimulation } from "./worker/simulation";
import type { SimulationConfig, AgentPersona, TickConfig, AgentAction } from "./types";

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    TOKENOMICS WAR GAME — Simulation Engine  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
  const onChain = flags.has("--on-chain");
  const scenarioPath = args[0] || "../scenarios/luna-ust.ts";
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

  const llm = buildLLMClient();
  const healthy = await llm.healthCheck();
  if (!healthy) {
    console.error(`ERROR: LLM provider (${llm.name}) health check failed.`);
    console.error("  For ollama: make sure 'ollama serve' is running and the model is pulled.");
    console.error("  For openrouter: check OPENROUTER_API_KEY.");
    process.exit(1);
  }
  const models = llm.listModels ? await llm.listModels() : [];
  console.log(`LLM: ${llm.name}`);
  if (models.length) console.log(`  Available models: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}\n`);
  else console.log();

  const db = new SimDatabase();
  const simId = crypto.randomUUID();
  console.log(`Simulation ID: ${simId}`);

  let lastCompletedTick = 0;
  let shutdownRequested = false;
  const gracefulShutdown = (signal: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`\n  Received ${signal} — finalizing DB and exiting…`);
    try {
      db.updateSimStatus(simId, "interrupted");
      db.updateSimTicks(simId, lastCompletedTick);
      db.close();
      console.log(`  Saved ${lastCompletedTick + 1} ticks to DB (simId=${simId})`);
    } catch (e) {
      console.error("  DB close error:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  console.log("\n" + "═".repeat(60));
  console.log("  SIMULATION STARTING");
  console.log("═".repeat(60));

  const summary = await runSimulation({
    simId,
    config,
    agents,
    tickConfig,
    llm,
    db,
    onChain,
    onTickStart: (tick) => {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`  TICK ${tick}`);
      console.log(`${"─".repeat(60)}`);
    },
    onTickComplete: (result) => {
      const s = result.stateAfter;
      console.log(
        `  Price: $${s.tokenPrice.toFixed(4)} | ` +
        `Gini: ${s.giniCoefficient.toFixed(3)} | ` +
        `Staked: ${((s.stakedSupply / s.totalSupply) * 100).toFixed(2)}% | ` +
        `Supply: ${s.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      );
      if (s.reserveBalance !== undefined && s.initialReserveBalance !== undefined) {
        const pct = (s.reserveBalance / s.initialReserveBalance) * 100;
        const peg = s.pegPrice ?? 1;
        console.log(
          `  Reserve: $${Math.round(s.reserveBalance).toLocaleString()} (${pct.toFixed(2)}%) | ` +
          `Peg: $${peg.toFixed(4)}${peg < 0.995 ? " ⚠ PEG BREAK" : ""}`
        );
      }
      console.log(`\n  Agent Decisions:`);
      for (const a of result.actions as AgentAction[]) {
        const status = a.success ? "✓" : "✗";
        const amountStr = a.amount !== null ? ` ${a.amount.toLocaleString()}` : "";
        console.log(`  [${status}] ${a.agentId.padEnd(12)} ${a.action.padEnd(10)}${amountStr}`);
        console.log(`      Reasoning: "${a.reasoning}"`);
        if (a.threatAssessment && a.threatAssessment !== "none") {
          console.log(`      Threat: "${a.threatAssessment}"`);
        }
      }
      console.log(`\n  Tick ${result.tick} completed in ${result.duration_ms}ms`);
      lastCompletedTick = result.tick;
    },
    onDeathSpiral: () => {
      console.log("\n  ╔═══════════════════════════════════════╗");
      console.log("  ║     💀 DEATH SPIRAL DETECTED 💀       ║");
      console.log("  ╚═══════════════════════════════════════╝");
    },
    onComplete: (s) => {
      const changePct = ((s.finalPrice - s.initialPrice) / s.initialPrice * 100).toFixed(2);
      console.log("\n" + "═".repeat(60));
      console.log("  SIMULATION COMPLETE");
      console.log("═".repeat(60));
      console.log(`  Total ticks: ${s.totalTicks}`);
      console.log(`  Initial price: $${s.initialPrice}`);
      console.log(`  Final price: $${s.finalPrice.toFixed(4)} (${changePct}%)`);
      console.log(`  Death spiral: ${s.deathSpiralDetected ? "YES" : "NO"}`);
    },
  });

  console.log(`\n  Simulation data saved (ID: ${simId})`);
  db.close();
  return summary;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
