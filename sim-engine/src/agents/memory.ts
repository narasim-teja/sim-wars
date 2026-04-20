import type { AgentAction } from "../types";
import type { SimDatabase } from "../db/database";

export interface ObservationOptions {
  /**
   * Ticks to defer before this observation becomes visible. 0 = immediate
   * (default). Used to model analysts publishing after the fact, or rate-
   * limited signal propagation.
   */
  delay?: number;
  /**
   * Fraction [0,1] of signal detail visible. Stores do NOT re-obscure on
   * write — the caller should pass an already-shaped AgentAction. This hint
   * is retained for future backends that want to downgrade fidelity at read
   * time (e.g., vector recall scoring).
   */
  fidelity?: number;
}

/**
 * Narrow interface behind which we can plug different memory backends.
 * Phase 2 ships two: `InMemoryStore` (current behavior, bounded arrays) and
 * `SqliteMemoryStore` (reads from the existing `agent_actions` table).
 * Phase 3+ can add Zep/mem0 without touching the orchestrator.
 */
export interface MemoryStore {
  /** Append an action the agent just took. */
  recordAction(agentId: string, action: AgentAction): void;

  /**
   * Notify an agent that another agent did something notable. `opts.delay`
   * buffers the observation until `advanceTick(t)` reaches that many ticks
   * past the action's original tick.
   */
  recordObservation(observerId: string, action: AgentAction, opts?: ObservationOptions): void;

  /**
   * Release any delayed observations whose visibility tick has now arrived.
   * Callers (the orchestrator / worker) invoke this at the start of each
   * tick so downstream `getRecentObservations` sees fresh-landed signals.
   */
  advanceTick(currentTick: number): void;

  /** Last N actions this agent took, chronological. */
  getRecentActions(agentId: string, n: number): AgentAction[];

  /** Last N actions this agent observed others taking, chronological. */
  getRecentObservations(agentId: string, n: number): AgentAction[];

  /** Memory-similarity retrieval hook. Returns [] for stores without vector recall. */
  getSimilarActions?(agentId: string, query: string, n: number): Promise<AgentAction[]>;
}

interface PendingObservation {
  observerId: string;
  action: AgentAction;
  visibleAtTick: number;
}

/**
 * Bounded in-process store. O(1) append, O(1) recent lookup. No persistence
 * beyond the run. Supports delayed observations via a small pending buffer
 * drained on `advanceTick`.
 */
export class InMemoryStore implements MemoryStore {
  private actions = new Map<string, AgentAction[]>();
  private observations = new Map<string, AgentAction[]>();
  private pending: PendingObservation[] = [];
  private currentTick = 0;

  constructor(private actionLimit = 20, private observationLimit = 10) {}

  recordAction(agentId: string, action: AgentAction): void {
    const list = this.actions.get(agentId) ?? [];
    list.push(action);
    if (list.length > this.actionLimit) list.splice(0, list.length - this.actionLimit);
    this.actions.set(agentId, list);
  }

  recordObservation(observerId: string, action: AgentAction, opts?: ObservationOptions): void {
    const delay = Math.max(0, opts?.delay ?? 0);
    if (delay === 0) {
      this.appendObservation(observerId, action);
      return;
    }
    this.pending.push({
      observerId,
      action,
      visibleAtTick: action.tick + delay,
    });
  }

  advanceTick(currentTick: number): void {
    this.currentTick = currentTick;
    if (this.pending.length === 0) return;
    const keep: PendingObservation[] = [];
    for (const p of this.pending) {
      if (p.visibleAtTick <= currentTick) {
        this.appendObservation(p.observerId, p.action);
      } else {
        keep.push(p);
      }
    }
    this.pending = keep;
  }

  getRecentActions(agentId: string, n: number): AgentAction[] {
    const list = this.actions.get(agentId) ?? [];
    return list.slice(-n);
  }

  getRecentObservations(agentId: string, n: number): AgentAction[] {
    const list = this.observations.get(agentId) ?? [];
    return list.slice(-n);
  }

  private appendObservation(observerId: string, action: AgentAction): void {
    const list = this.observations.get(observerId) ?? [];
    list.push(action);
    if (list.length > this.observationLimit) list.splice(0, list.length - this.observationLimit);
    this.observations.set(observerId, list);
  }
}

/**
 * SQLite-backed reader over the existing `agent_actions` table.
 * Writes go through both the DB (via orchestrator → `db.insertAction`) and
 * an in-mem hot cache so recent-action lookups stay O(1) in the tick loop.
 * Durable across restarts; useful for resuming paused sims.
 */
export class SqliteMemoryStore implements MemoryStore {
  private hot = new InMemoryStore();

  constructor(private db: SimDatabase, private simId: string) {}

  recordAction(agentId: string, action: AgentAction): void {
    this.hot.recordAction(agentId, action);
  }

  recordObservation(observerId: string, action: AgentAction, opts?: ObservationOptions): void {
    this.hot.recordObservation(observerId, action, opts);
  }

  advanceTick(currentTick: number): void {
    this.hot.advanceTick(currentTick);
  }

  getRecentActions(agentId: string, n: number): AgentAction[] {
    const hotHits = this.hot.getRecentActions(agentId, n);
    if (hotHits.length >= n) return hotHits;
    return this.db.getAgentHistory(this.simId, agentId, n);
  }

  getRecentObservations(agentId: string, n: number): AgentAction[] {
    return this.hot.getRecentObservations(agentId, n);
  }
}
