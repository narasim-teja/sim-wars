/**
 * Dump a scenario .ts module to JSON in `frontend/lib/scenarios/<name>.json`.
 *
 *   bun run scripts/dump-scenario-json.ts luna
 *   bun run scripts/dump-scenario-json.ts marinade
 *   bun run scripts/dump-scenario-json.ts jito
 *
 * The frontend's preset launcher loads the JSON shape `{ config, agents, tickConfig }`
 * directly. Keeping the .ts source-of-truth + a build-time dump means we don't
 * hand-maintain ~600-line JSON files.
 */
import "../src/bootstrap";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: bun run scripts/dump-scenario-json.ts <luna|marinade|jito>");
    process.exit(2);
  }
  const scenarioModule = await import(`../scenarios/${name}.ts`);
  const scenario = scenarioModule.default ?? scenarioModule;
  if (!scenario.config || !scenario.agents || !scenario.tickConfig) {
    throw new Error(`scenario ${name} is missing config/agents/tickConfig`);
  }
  const payload = {
    config: scenario.config,
    agents: scenario.agents,
    tickConfig: scenario.tickConfig,
  };
  const outPath = resolve(__dirname, "../../frontend/lib/scenarios", `${name}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`wrote ${outPath} (${payload.agents.length} agents, ${payload.tickConfig.maxTicks} ticks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
