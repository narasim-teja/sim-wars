import type { AgentAction } from "../types";
import type { SimDatabase } from "../db/database";

/**
 * Narrow interface behind which we can plug different memory backends.
 * Phase 2 ships two: `InMemoryStore` (current behavior, bounded arrays) and
 * `SqliteMemoryStore` (reads from the existing `agent_actions` table).
 * Phase 3+ can add Zep/mem0 without touching the orchestrator.
 */
export interface MemoryStore {
  /** Append an action the agent just took. */
  recordAction(agentId: string, action: AgentAction): void;

  /** Notify an agent that another agent did something notable. */
  recordObservation(observerId: string, action: AgentAction): void;

  /** Last N actions this agent took, chronological. */
  getRecentActions(agentId: string, n: number): AgentAction[];

  /** Last N actions this agent observed others taking, chronological. */
  getRecentObservations(agentId: string, n: number): AgentAction[];

  /** Memory-similarity retrieval hook. Returns [] for stores without vector recall. */
  getSimilarActions?(agentId: string, query: string, n: number): Promise<AgentAction[]>;
}

/**
 * Bounded in-process store. O(1) append, O(1) recent lookup. No persistence
 * beyond the run. Mirrors Phase 1 behavior so cutover is a no-op.
 */
export class InMemoryStore implements MemoryStore {
  private actions = new Map<string, AgentAction[]>();
  private observations = new Map<string, AgentAction[]>();

  constructor(private actionLimit = 20, private observationLimit = 10) {}

  recordAction(agentId: string, action: AgentAction): void {
    const list = this.actions.get(agentId) ?? [];
    list.push(action);
    if (list.length > this.actionLimit) list.splice(0, list.length - this.actionLimit);
    this.actions.set(agentId, list);
  }

  recordObservation(observerId: string, action: AgentAction): void {
    const list = this.observations.get(observerId) ?? [];
    list.push(action);
    if (list.length > this.observationLimit) list.splice(0, list.length - this.observationLimit);
    this.observations.set(observerId, list);
  }

  getRecentActions(agentId: string, n: number): AgentAction[] {
    const list = this.actions.get(agentId) ?? [];
    return list.slice(-n);
  }

  getRecentObservations(agentId: string, n: number): AgentAction[] {
    const list = this.observations.get(agentId) ?? [];
    return list.slice(-n);
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

  recordObservation(observerId: string, action: AgentAction): void {
    this.hot.recordObservation(observerId, action);
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
