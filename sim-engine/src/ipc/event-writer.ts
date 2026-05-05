import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TickResult, AgentAction, SimulationState } from "../types";
import type { LLMUsage } from "../llm/types";

/**
 * Events the worker emits to the API server (and, via WS, to the frontend).
 * Each line of `events.ndjson` is one event. Append-only. No rotation yet.
 */
export type WorkerEvent =
  | { kind: "sim:start"; ts: number; simId: string; agentCount: number; maxTicks: number }
  | { kind: "tick:start"; ts: number; tick: number }
  | {
      kind: "tick:complete";
      ts: number;
      tick: number;
      duration_ms: number;
      state: SimulationState;
      actions: AgentAction[];
      /** Per-tick LLM usage drained after batch completes. Omitted if the client doesn't report. */
      llmUsage?: LLMUsage;
    }
  | { kind: "agent:action"; ts: number; tick: number; action: AgentAction }
  | {
      kind: "sim:complete";
      ts: number;
      simId: string;
      status: SimStatus;
      totalTicks: number;
      /** Cumulative LLM usage across the whole run. Omitted if the client doesn't report. */
      llmUsage?: LLMUsage;
    }
  | { kind: "sim:death_spiral"; ts: number; simId: string; tick: number }
  | { kind: "report:start"; ts: number; simId: string }
  | { kind: "report:ready"; ts: number; simId: string; resilienceScore: number; resilienceGrade: string }
  | { kind: "report:error"; ts: number; simId: string; message: string }
  | { kind: "chain:deploy:start"; ts: number; simId: string; step: string }
  | { kind: "chain:deploy:progress"; ts: number; simId: string; step: string; message: string }
  | { kind: "chain:deploy:complete"; ts: number; simId: string; programs: string[] }
  | { kind: "chain:deploy:error"; ts: number; simId: string; message: string }
  | {
      kind: "chain:prestake:start";
      ts: number;
      simId: string;
      total: number;
    }
  | {
      kind: "chain:prestake:progress";
      ts: number;
      simId: string;
      agentId: string;
      current: number;
      total: number;
      succeeded: number;
      failed: number;
    }
  | {
      kind: "chain:prestake:complete";
      ts: number;
      simId: string;
      total: number;
      succeeded: number;
      failed: number;
      durationMs: number;
    }
  | { kind: "error"; ts: number; tick: number | null; message: string }
  | { kind: "log"; ts: number; level: "info" | "warn" | "error"; message: string };

export type SimStatus = "running" | "paused" | "completed" | "failed" | "death_spiral" | "interrupted";

export interface StatusSnapshot {
  simId: string;
  status: SimStatus;
  tick: number;
  updatedAt: number;
}

/**
 * Append-only NDJSON writer + status-file updater. The API server tails the
 * events file line-by-line to broadcast to WS clients, and reads the status
 * file for cheap "is this run still alive?" polling.
 */
export class EventWriter {
  constructor(private eventsFile: string, private statusFile: string) {
    mkdirSync(dirname(eventsFile), { recursive: true });
    mkdirSync(dirname(statusFile), { recursive: true });
  }

  emit(event: WorkerEvent): void {
    appendFileSync(this.eventsFile, JSON.stringify(event) + "\n");
  }

  emitTickComplete(result: TickResult): void {
    this.emit({
      kind: "tick:complete",
      ts: Date.now(),
      tick: result.tick,
      duration_ms: result.duration_ms,
      state: result.stateAfter,
      actions: result.actions,
      llmUsage: result.llmUsage,
    });
  }

  writeStatus(snap: StatusSnapshot): void {
    writeFileSync(this.statusFile, JSON.stringify(snap, null, 2));
  }
}
