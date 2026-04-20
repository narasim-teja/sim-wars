import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Commands the API server writes; the worker polls.
 * Each command is one JSON file under `commands/`. The worker consumes
 * each file exactly once — it reads, deletes, then acts on the payload.
 */
export type WorkerCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abort" };

/**
 * Directory-polling command reader. No fs.watch — it's flaky across
 * platforms and doesn't survive container layering. Polling is a few ms
 * per tick and we only check between ticks, so cost is negligible.
 */
export class CommandReader {
  constructor(private commandsDir: string) {
    mkdirSync(this.commandsDir, { recursive: true });
  }

  /** Drain any pending commands. Files are deleted after reading. */
  drain(): WorkerCommand[] {
    if (!existsSync(this.commandsDir)) return [];
    const files = readdirSync(this.commandsDir)
      .filter((f) => f.endsWith(".json"))
      .sort(); // filename-sorted to get FIFO with numeric prefixes

    const out: WorkerCommand[] = [];
    for (const name of files) {
      const full = join(this.commandsDir, name);
      try {
        const body = readFileSync(full, "utf-8");
        out.push(JSON.parse(body) as WorkerCommand);
      } catch (err) {
        console.warn(`  [ipc] bad command file ${name}:`, (err as Error).message);
      } finally {
        try { unlinkSync(full); } catch { /* already gone */ }
      }
    }
    return out;
  }
}

let commandCounter = 0;

/** API-side helper for writing commands. Filename is wall-clock ms + a
 *  process-local counter so rapid writes within the same millisecond still
 *  sort deterministically. */
export function writeCommand(commandsDir: string, cmd: WorkerCommand): string {
  mkdirSync(commandsDir, { recursive: true });
  const seq = String(commandCounter++).padStart(6, "0");
  const name = `${Date.now()}-${seq}-${cmd.type}.json`;
  const full = join(commandsDir, name);
  writeFileSync(full, JSON.stringify(cmd));
  return full;
}
