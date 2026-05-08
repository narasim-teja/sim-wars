/**
 * Record a sim into `runs-demo/<simId>/` so it shows up as a replayable
 * card on the landing page. Talks to a running API server (default
 * http://localhost:8787) — start one in another terminal first:
 *
 *   bun run api
 *
 * Then in this terminal:
 *
 *   bun run scripts/record-demo.ts \
 *     --scenario ../frontend/lib/scenarios/luna-20.json \
 *     --name "LUNA-UST — algorithmic death spiral" \
 *     --description "Anchor's 19.45% APY + algo stable + zero lock = the May 2022 collapse."
 *
 * The script POSTs the scenario, polls until completion, then copies the
 * run artifacts (events.ndjson, scenario.json, status.json, report.json,
 * commands/) from `RUNS_DIR/<simId>/` into `runs-demo/<simId>/` and writes
 * a `meta.json` with the supplied name + description. Adding the new demo
 * to the landing requires nothing else — the API picks it up on next boot.
 */
import "../src/bootstrap";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, DEMO_RUNS_DIR, pathsFor } from "../src/ipc/paths";

interface Args {
  scenarioPath: string;
  name: string;
  description: string;
  api: string;
  pollMs: number;
  timeoutMs: number;
  /** Optional override — replay is instant regardless, so 0 here just speeds up recording. */
  intervalMs: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scenarioPath = get("--scenario");
  const name = get("--name");
  const description = get("--description");
  if (!scenarioPath || !name || !description) {
    console.error(
      "Usage: bun run scripts/record-demo.ts --scenario <path> --name <str> --description <str> [--api http://localhost:8787]",
    );
    process.exit(2);
  }
  const intervalRaw = get("--interval-ms");
  return {
    scenarioPath,
    name,
    description,
    api: get("--api") ?? "http://localhost:8787",
    pollMs: Number(get("--poll-ms") ?? 2000),
    timeoutMs: Number(get("--timeout-ms") ?? 30 * 60_000),
    intervalMs: intervalRaw === undefined ? null : Number(intervalRaw),
  };
}

interface CreateResp { simId: string; status: string; agentCount: number }
interface StatusResp { simId: string; status: string; tick: number; hasReport?: boolean }

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status}: ${(await r.text()).slice(0, 240)}`);
  return r.json() as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

async function main() {
  const args = parseArgs();

  const scenarioBody = JSON.parse(readFileSync(args.scenarioPath, "utf-8"));
  // Demos are NDJSON recordings only — never deploy on-chain when recording.
  scenarioBody.onChain = false;
  if (args.intervalMs !== null) {
    scenarioBody.tickConfig = { ...scenarioBody.tickConfig, intervalMs: args.intervalMs };
    console.log(`  intervalMs override: ${args.intervalMs}`);
  }

  console.log(`POST ${args.api}/api/sim  (scenario: ${args.scenarioPath})`);
  const created = await postJson<CreateResp>(`${args.api}/api/sim`, scenarioBody);
  console.log(`  → simId=${created.simId} agents=${created.agentCount}`);

  const startedAt = Date.now();
  let lastTick = -1;
  for (;;) {
    if (Date.now() - startedAt > args.timeoutMs) {
      throw new Error(`Timeout (${args.timeoutMs}ms) waiting for simId=${created.simId}`);
    }
    const status = await getJson<StatusResp>(`${args.api}/api/sim/${created.simId}`);
    if (status.tick !== lastTick) {
      process.stdout.write(`  tick ${status.tick} (${status.status})\r`);
      lastTick = status.tick;
    }
    if (status.status === "completed" || status.status === "death_spiral") {
      // Wait one more poll cycle for report.json to be written by the worker
      // (sim:complete event fires before the report writer flushes).
      if (status.hasReport) {
        process.stdout.write("\n");
        break;
      }
    }
    if (status.status === "failed" || status.status === "interrupted") {
      throw new Error(`Run ended with status=${status.status} at tick=${status.tick}`);
    }
    await new Promise((res) => setTimeout(res, args.pollMs));
  }

  // Copy artifacts from RUNS_DIR/<simId>/ → runs-demo/<simId>/
  const src = pathsFor(created.simId, RUNS_DIR);
  const dstDir = join(DEMO_RUNS_DIR, created.simId);
  if (!existsSync(src.statusFile)) throw new Error(`Source run dir missing: ${src.root}`);
  mkdirSync(dstDir, { recursive: true });
  cpSync(src.root, dstDir, { recursive: true });

  // Drop SQLite artifacts (sim.sqlite + journal/WAL/SHM) — replays only
  // read events.ndjson + report.json, and the SQLite file alone can be
  // 10× the size of the rest combined.
  for (const name of readdirSync(dstDir)) {
    if (name.startsWith("sim.sqlite")) unlinkSync(join(dstDir, name));
  }

  writeFileSync(
    join(dstDir, "meta.json"),
    JSON.stringify({ name: args.name, description: args.description }, null, 2) + "\n",
  );

  const report = JSON.parse(readFileSync(join(dstDir, "report.json"), "utf-8")) as {
    resilienceScore: number;
    resilienceGrade: string;
    meta: { deathSpiralDetected: boolean; finalPrice: number; totalTicks: number };
  };

  console.log("\n✓ recorded demo:");
  console.log(`  simId:     ${created.simId}`);
  console.log(`  dir:       ${dstDir}`);
  console.log(`  name:      ${args.name}`);
  console.log(`  ticks:     ${report.meta.totalTicks}`);
  console.log(`  finalPrice:$${report.meta.finalPrice.toFixed(4)}`);
  console.log(`  grade:     ${report.resilienceGrade} (${report.resilienceScore}/100)`);
  console.log(`  spiral:    ${report.meta.deathSpiralDetected ? "YES" : "no"}`);
  console.log("\nRestart the API (or wait for next deploy) — the demo will appear on /demos and the landing page.");
}

main().catch((err) => {
  console.error("record-demo failed:", err.message);
  process.exit(1);
});
