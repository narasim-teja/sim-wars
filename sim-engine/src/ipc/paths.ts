import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project-root-relative `runs/` directory, one subdirectory per simulation.
 * Each run owns: commands/ (api → worker), events.ndjson (worker → api),
 * sim.sqlite, and a snapshot of its scenario config.
 */
export const RUNS_DIR = join(__dirname, "../../.local/runs");

export interface RunPaths {
  simId: string;
  root: string;
  commandsDir: string;
  eventsFile: string;
  scenarioFile: string;
  dbFile: string;
  statusFile: string;
}

export function pathsFor(simId: string, runsDir: string = RUNS_DIR): RunPaths {
  const root = join(runsDir, simId);
  return {
    simId,
    root,
    commandsDir: join(root, "commands"),
    eventsFile: join(root, "events.ndjson"),
    scenarioFile: join(root, "scenario.json"),
    dbFile: join(root, "sim.sqlite"),
    statusFile: join(root, "status.json"),
  };
}
