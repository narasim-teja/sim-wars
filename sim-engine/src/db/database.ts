import { Database } from "bun:sqlite";
import type { AgentAction, SimulationState, SimulationConfig } from "../types";

export class SimDatabase {
  private db: Database;

  // Prepared statements for hot-path operations
  private insertActionStmt;
  private insertTickStateStmt;
  private insertAgentStateStmt;

  constructor(dbPath: string = "sim-data.sqlite") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initialize();

    this.insertActionStmt = this.db.prepare(`
      INSERT INTO agent_actions (sim_id, tick, agent_id, action, amount, reasoning, threat_assessment, tx_signature, success, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertTickStateStmt = this.db.prepare(`
      INSERT INTO tick_states (sim_id, tick, state, duration_ms)
      VALUES (?, ?, ?, ?)
    `);

    this.insertAgentStateStmt = this.db.prepare(`
      INSERT INTO agent_states (sim_id, tick, agent_id, token_balance, staked_balance, usdc_balance)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulations (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        total_ticks INTEGER,
        status TEXT DEFAULT 'running'
      );

      CREATE TABLE IF NOT EXISTS tick_states (
        sim_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        state TEXT NOT NULL,
        duration_ms INTEGER,
        PRIMARY KEY (sim_id, tick),
        FOREIGN KEY (sim_id) REFERENCES simulations(id)
      );

      CREATE TABLE IF NOT EXISTS agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sim_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL,
        reasoning TEXT,
        threat_assessment TEXT,
        tx_signature TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (sim_id) REFERENCES simulations(id)
      );

      CREATE TABLE IF NOT EXISTS agent_states (
        sim_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        token_balance REAL NOT NULL,
        staked_balance REAL NOT NULL,
        usdc_balance REAL NOT NULL,
        PRIMARY KEY (sim_id, tick, agent_id),
        FOREIGN KEY (sim_id) REFERENCES simulations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_actions_agent ON agent_actions(sim_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_actions_tick ON agent_actions(sim_id, tick);
    `);
  }

  createSimulation(simId: string, config: SimulationConfig): void {
    this.db.run(
      "INSERT INTO simulations (id, config, started_at) VALUES (?, ?, ?)",
      [simId, JSON.stringify(config), Date.now()]
    );
  }

  updateSimStatus(
    simId: string,
    status: "running" | "completed" | "failed" | "death_spiral"
  ): void {
    this.db.run(
      "UPDATE simulations SET status = ?, completed_at = ? WHERE id = ?",
      [status, Date.now(), simId]
    );
  }

  updateSimTicks(simId: string, totalTicks: number): void {
    this.db.run(
      "UPDATE simulations SET total_ticks = ? WHERE id = ?",
      [totalTicks, simId]
    );
  }

  insertAction(simId: string, action: AgentAction): void {
    this.insertActionStmt.run(
      simId,
      action.tick,
      action.agentId,
      action.action,
      action.amount,
      action.reasoning,
      action.threatAssessment,
      action.txSignature,
      action.success ? 1 : 0,
      action.timestamp
    );
  }

  insertTickState(
    simId: string,
    tick: number,
    state: SimulationState,
    durationMs: number
  ): void {
    this.insertTickStateStmt.run(
      simId,
      tick,
      JSON.stringify(state),
      durationMs
    );
  }

  insertAgentState(
    simId: string,
    tick: number,
    agentId: string,
    balances: { token: number; staked: number; usdc: number }
  ): void {
    this.insertAgentStateStmt.run(
      simId,
      tick,
      agentId,
      balances.token,
      balances.staked,
      balances.usdc
    );
  }

  getAgentHistory(simId: string, agentId: string, lastN: number): AgentAction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_actions WHERE sim_id = ? AND agent_id = ? ORDER BY tick DESC LIMIT ?`
      )
      .all(simId, agentId, lastN) as Record<string, unknown>[];

    return rows.reverse().map((row) => ({
      tick: row.tick as number,
      agentId: row.agent_id as string,
      action: row.action as AgentAction["action"],
      amount: row.amount as number | null,
      reasoning: row.reasoning as string,
      threatAssessment: row.threat_assessment as string,
      txSignature: row.tx_signature as string | null,
      success: (row.success as number) === 1,
      timestamp: row.timestamp as number,
    }));
  }

  getTickStates(simId: string): SimulationState[] {
    const rows = this.db
      .prepare("SELECT state FROM tick_states WHERE sim_id = ? ORDER BY tick")
      .all(simId) as { state: string }[];

    return rows.map((row) => JSON.parse(row.state) as SimulationState);
  }

  close(): void {
    this.db.close();
  }
}
