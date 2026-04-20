import { readFileSync, existsSync } from "node:fs";
import { SimDatabase } from "../db/database";
import { buildLLMClient } from "../llm/factory";
import { pathsFor } from "../ipc/paths";
import { EventWriter, type SimStatus } from "../ipc/event-writer";
import { CommandReader, type WorkerCommand } from "../ipc/command-reader";
import { runSimulation } from "./simulation";
import type { SimulationConfig, AgentPersona, TickConfig } from "../types";

interface ScenarioPayload {
  config: SimulationConfig;
  agents: AgentPersona[];
  tickConfig: TickConfig;
  onChain?: boolean;
}

function parseArgs(argv: string[]): { simId: string | null } {
  let simId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sim-id" && argv[i + 1]) {
      simId = argv[i + 1]!;
      i++;
    }
  }
  return { simId: simId ?? process.env.SIM_ID ?? null };
}

async function main() {
  const { simId } = parseArgs(process.argv.slice(2));
  if (!simId) {
    console.error("worker: --sim-id <uuid> is required (or set SIM_ID env)");
    process.exit(2);
  }

  const paths = pathsFor(simId);
  if (!existsSync(paths.scenarioFile)) {
    console.error(`worker: missing ${paths.scenarioFile}`);
    process.exit(2);
  }

  const scenario = JSON.parse(readFileSync(paths.scenarioFile, "utf-8")) as ScenarioPayload;

  const events = new EventWriter(paths.eventsFile, paths.statusFile);
  const commands = new CommandReader(paths.commandsDir);
  const db = new SimDatabase(paths.dbFile);
  const llm = buildLLMClient();

  const setStatus = (status: SimStatus, tick: number) =>
    events.writeStatus({ simId, status, tick, updatedAt: Date.now() });
  setStatus("running", 0);

  // Command state (mutated by drainCommands)
  let paused = false;
  let aborted = false;
  const drainCommands = (): void => {
    const batch = commands.drain();
    for (const cmd of batch) applyCommand(cmd);
  };
  const applyCommand = (cmd: WorkerCommand): void => {
    if (cmd.type === "pause") paused = true;
    else if (cmd.type === "resume") paused = false;
    else if (cmd.type === "abort") aborted = true;
  };

  // Graceful shutdown
  let shuttingDown = false;
  const onSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    events.emit({ kind: "log", ts: Date.now(), level: "warn", message: `received ${sig}` });
    aborted = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let lastTick = 0;

  try {
    await runSimulation({
      simId,
      config: scenario.config,
      agents: scenario.agents,
      tickConfig: scenario.tickConfig,
      llm,
      db,
      onChain: scenario.onChain ?? false,
      onStart: ({ agentCount, maxTicks }) => {
        events.emit({ kind: "sim:start", ts: Date.now(), simId, agentCount, maxTicks });
      },
      onTickStart: (tick) => {
        lastTick = tick;
        events.emit({ kind: "tick:start", ts: Date.now(), tick });
        setStatus(paused ? "paused" : "running", tick);
      },
      onTickComplete: (result) => {
        events.emitTickComplete(result);
        lastTick = result.tick;
      },
      onDeathSpiral: (tick) => {
        events.emit({ kind: "sim:death_spiral", ts: Date.now(), simId, tick });
      },
      shouldPause: () => {
        drainCommands();
        if (aborted) return "abort";
        return paused;
      },
    });

    const status: SimStatus = aborted ? "interrupted" : "completed";
    setStatus(status, lastTick);
    events.emit({ kind: "sim:complete", ts: Date.now(), simId, status, totalTicks: lastTick });
  } catch (err) {
    events.emit({ kind: "error", ts: Date.now(), tick: lastTick, message: (err as Error).message });
    setStatus("failed", lastTick);
    db.close();
    throw err;
  }

  db.close();
}

main().catch((err) => {
  console.error("worker fatal:", err);
  process.exit(1);
});
