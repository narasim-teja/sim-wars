import { EventEmitter } from "events";
import type { TickResult } from "../types";

export interface TickEvents {
  "tick:start": { tick: number };
  "tick:complete": TickResult;
  "sim:complete": { totalTicks: number; results: TickResult[] };
  "sim:error": { tick: number; error: Error };
}

export class TickController extends EventEmitter {
  private currentTick = 0;
  private running = false;
  private intervalMs: number;
  private maxTicks: number;
  private results: TickResult[] = [];
  private tickResolve: (() => void) | null = null;

  constructor(config: { intervalMs: number; maxTicks: number }) {
    super();
    this.intervalMs = config.intervalMs;
    this.maxTicks = config.maxTicks;
  }

  async start(): Promise<TickResult[]> {
    this.running = true;
    console.log(
      `\n=== Simulation starting: ${this.maxTicks} ticks, ${this.intervalMs}ms interval ===\n`
    );

    while (this.running && this.currentTick < this.maxTicks) {
      const tickStart = Date.now();

      this.emit("tick:start", { tick: this.currentTick });

      // Wait for external code to call markTickComplete()
      await this.waitForTickCompletion();

      const elapsed = Date.now() - tickStart;
      const sleepTime = Math.max(0, this.intervalMs - elapsed);
      if (sleepTime > 0) {
        await Bun.sleep(sleepTime);
      }

      this.currentTick++;
    }

    this.emit("sim:complete", {
      totalTicks: this.currentTick,
      results: this.results,
    });

    return this.results;
  }

  markTickComplete(result: TickResult): void {
    this.results.push(result);
    this.emit("tick:complete", result);

    if (this.tickResolve) {
      this.tickResolve();
      this.tickResolve = null;
    }
  }

  stop(): void {
    this.running = false;
    // Unblock any waiting tick
    if (this.tickResolve) {
      this.tickResolve();
      this.tickResolve = null;
    }
  }

  getCurrentTick(): number {
    return this.currentTick;
  }

  isRunning(): boolean {
    return this.running;
  }

  private waitForTickCompletion(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.tickResolve = resolve;
    });
  }
}
