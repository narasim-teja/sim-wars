import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project-root-relative `runs/` directory, one subdirectory per simulation.
 * Each run owns: commands/ (api → worker), events.ndjson (worker → api),
 * sim.sqlite, and a snapshot of its scenario config.
 */
export const RUNS_DIR = process.env.SIM_RUNS_DIR
  ? process.env.SIM_RUNS_DIR
  : join(__dirname, "../../.local/runs");

/**
 * Read-only baked-in demo recordings shipped in the image at
 * `sim-engine/runs-demo/`. The API server scans this on boot and exposes
 * each subdirectory as a replayable run. Pause/resume/abort are no-ops
 * because there's no worker behind a demo.
 */
export const DEMO_RUNS_DIR = process.env.SIM_DEMO_RUNS_DIR
  ? process.env.SIM_DEMO_RUNS_DIR
  : join(__dirname, "../../runs-demo");

export interface RunPaths {
  simId: string;
  root: string;
  commandsDir: string;
  eventsFile: string;
  scenarioFile: string;
  dbFile: string;
  statusFile: string;
  /** Generated post-sim by the report generator. */
  reportFile: string;
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
    reportFile: join(root, "report.json"),
  };
}

/**
 * Resolves a simId to its on-disk paths, preferring the live `runs/` dir
 * but falling back to `runs-demo/` so demo replays go through the same
 * API surface as live runs.
 */
export function resolveRunPaths(simId: string): RunPaths {
  const live = pathsFor(simId, RUNS_DIR);
  if (existsSync(live.statusFile)) return live;
  const demo = pathsFor(simId, DEMO_RUNS_DIR);
  if (existsSync(demo.statusFile)) return demo;
  return live;
}

export function isDemoRun(simId: string): boolean {
  return existsSync(pathsFor(simId, DEMO_RUNS_DIR).statusFile);
}
