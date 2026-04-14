/**
 * LUNA backtest verifier (Phase 1 Step 8).
 *
 * Usage:
 *   bun run scenarios/verify-luna.ts <sim_id>
 *   bun run scenarios/verify-luna.ts --latest
 *
 * Checks the 5 criteria from docs/phase1.md:
 *   1. Price drops below $1 (from $85)
 *   2. Staking ratio drops below 10%
 *   3. Agent reasoning mentions "unsustainable" / "reserve" / "depleting"
 *   4. Total supply increased (hyperinflation from mint-from-burn)
 *   5. Cascade pattern: farmer unstake → whale sell → degen sell (within 5 ticks)
 */
import { Database } from "bun:sqlite";
import type { SimulationState, AgentAction } from "../src/types";

const DB_PATH = "sim-data.sqlite";

function usage(): never {
  console.error("Usage: bun run scenarios/verify-luna.ts <sim_id|--latest>");
  process.exit(2);
}

function resolveSimId(db: Database, arg: string | undefined): string {
  if (!arg) usage();
  if (arg === "--latest") {
    const row = db
      .prepare("SELECT id FROM simulations ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string } | null;
    if (!row) {
      console.error("No simulations in database.");
      process.exit(1);
    }
    return row.id;
  }
  return arg;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function fmtResult(c: Check): string {
  const mark = c.pass ? "✅" : "❌";
  return `  ${mark} ${c.name}\n     ${c.detail}`;
}

function main() {
  const arg = process.argv[2];
  const db = new Database(DB_PATH, { readonly: true });
  const simId = resolveSimId(db, arg);

  const simRow = db
    .prepare("SELECT * FROM simulations WHERE id = ?")
    .get(simId) as
    | {
        id: string;
        status: string;
        total_ticks: number | null;
        started_at: number;
      }
    | null;

  if (!simRow) {
    console.error(`No simulation found with id=${simId}`);
    process.exit(1);
  }

  const tickRows = db
    .prepare("SELECT state FROM tick_states WHERE sim_id = ? ORDER BY tick")
    .all(simId) as { state: string }[];
  const states: SimulationState[] = tickRows.map((r) => JSON.parse(r.state));

  const actionRows = db
    .prepare(
      "SELECT tick, agent_id, action, amount, reasoning, threat_assessment, success, timestamp FROM agent_actions WHERE sim_id = ? ORDER BY tick, timestamp"
    )
    .all(simId) as {
    tick: number;
    agent_id: string;
    action: string;
    amount: number | null;
    reasoning: string;
    threat_assessment: string;
    success: number;
    timestamp: number;
  }[];
  const actions: AgentAction[] = actionRows.map((r) => ({
    tick: r.tick,
    agentId: r.agent_id,
    action: r.action as AgentAction["action"],
    amount: r.amount,
    reasoning: r.reasoning,
    threatAssessment: r.threat_assessment,
    txSignature: null,
    success: r.success === 1,
    timestamp: r.timestamp,
  }));

  if (states.length === 0) {
    console.error("Simulation has no tick state rows — aborting.");
    process.exit(1);
  }

  console.log(`\nVerifying simulation ${simId}`);
  console.log(`  status=${simRow.status} ticks=${states.length}\n`);

  const firstState = states[0];
  const lastState = states[states.length - 1];

  // Criterion 1: price < $1
  const initialPrice = firstState.tokenPrice;
  const finalPrice = lastState.tokenPrice;
  const c1: Check = {
    name: "Price collapse (final < $1, from $85 start)",
    pass: finalPrice < 1 && initialPrice > 10,
    detail: `initial=$${initialPrice.toFixed(2)}, final=$${finalPrice.toFixed(4)}`,
  };

  // Criterion 2: staking ratio < 10% at some point
  const minStakingRatio = states.reduce((min, s) => {
    if (s.totalSupply <= 0) return min;
    const r = s.stakedSupply / s.totalSupply;
    return r < min ? r : min;
  }, Infinity);
  const c2: Check = {
    name: "Staking ratio drops below 10%",
    pass: minStakingRatio < 0.1,
    detail: `min staking ratio observed = ${(minStakingRatio * 100).toFixed(2)}%`,
  };

  // Criterion 3: ≥3 action reasonings mention the keywords
  const keywords = /\b(unsustainab|reserve|deplet|peg|cascade|hyperinflat)/i;
  const triggered = actions.filter(
    (a) => a.reasoning && keywords.test(a.reasoning)
  );
  const c3: Check = {
    name: "Agent reasoning reflects death-spiral signals (≥3 triggered decisions)",
    pass: triggered.length >= 3,
    detail: `${triggered.length} actions mention unsustainable/reserve/peg/cascade`,
  };

  // Criterion 4: total_supply increased
  const initialSupply = firstState.totalSupply;
  const maxSupply = states.reduce((m, s) => Math.max(m, s.totalSupply), 0);
  const c4: Check = {
    name: "Hyperinflation (total supply grew)",
    pass: maxSupply > initialSupply,
    detail: `initial=${initialSupply.toLocaleString()}, max=${maxSupply.toLocaleString()} (+${(
      (maxSupply / initialSupply - 1) * 100
    ).toFixed(2)}%)`,
  };

  // Criterion 5: cascade — farmer unstake → whale sell → degen sell within 5 ticks
  const firstFarmerUnstake = actions.find(
    (a) => a.agentId.startsWith("FARMER") && a.action === "unstake" && a.success
  );
  const firstWhaleSell = actions.find(
    (a) =>
      a.agentId.startsWith("WHALE") &&
      a.action === "sell" &&
      a.success &&
      firstFarmerUnstake !== undefined &&
      a.tick >= firstFarmerUnstake.tick
  );
  const firstDegenSell = actions.find(
    (a) =>
      a.agentId.startsWith("DEGEN") &&
      a.action === "sell" &&
      a.success &&
      firstWhaleSell !== undefined &&
      a.tick >= firstWhaleSell.tick
  );
  const cascadeOk =
    firstFarmerUnstake !== undefined &&
    firstWhaleSell !== undefined &&
    firstDegenSell !== undefined &&
    firstWhaleSell.tick - firstFarmerUnstake.tick <= 5 &&
    firstDegenSell.tick - firstWhaleSell.tick <= 5;
  const c5: Check = {
    name: "Cascade pattern: farmer unstake → whale sell → degen sell",
    pass: cascadeOk,
    detail: firstFarmerUnstake
      ? `farmer(t${firstFarmerUnstake.tick})` +
        (firstWhaleSell ? ` → whale(t${firstWhaleSell.tick})` : " → whale(none)") +
        (firstDegenSell ? ` → degen(t${firstDegenSell.tick})` : " → degen(none)")
      : "no farmer unstake observed",
  };

  const checks = [c1, c2, c3, c4, c5];
  for (const c of checks) console.log(fmtResult(c));

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\nResult: ${passed}/${checks.length} criteria passed.`);
  process.exit(passed === checks.length ? 0 : 1);
}

main();
