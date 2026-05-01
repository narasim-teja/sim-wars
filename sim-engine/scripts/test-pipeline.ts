/**
 * Pre-flight pipeline test. Run this BEFORE the full e2e to validate each
 * stage in isolation. The full e2e bundles 4 stages, so a failure tells you
 * very little about which one broke. This script tests:
 *
 *   1. ENV     — root .env loaded, OPENROUTER_API_KEY present
 *   2. LLM     — OpenRouter reachable, can return a JSON-shaped response
 *   3. NORM    — config normalizer fills in defaults from a sparse object
 *   4. ROSTER  — expander produces N agents at the requested scale
 *   5. RPC     — Solana RPC reachable, deployer has SOL
 *
 * Each stage is independent and prints its own pass/fail line so a CI run
 * can grep for "FAIL".
 *
 * Usage:
 *   bun run scripts/test-pipeline.ts                    # run all 5 stages
 *   bun run scripts/test-pipeline.ts --skip-rpc         # skip RPC (no localnet)
 *   bun run scripts/test-pipeline.ts --roster-size 1000 # stress roster expansion
 */
import "../src/bootstrap";
import { buildLLMClient } from "../src/llm/factory";
import { normalizeConfig } from "../src/scenarios/normalize";
import { expandRoster } from "../src/agents/roster";
import { resolveRpcUrl, getConnection } from "../src/chain/connection";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

interface Args {
  skipRpc: boolean;
  rosterSize: number;
  promptText: string;
}

function parseArgs(argv: string[]): Args {
  let skipRpc = false;
  let rosterSize = 100;
  let promptText = `Return ONLY this exact JSON: {"action":"hold","amount":null,"reasoning":"pipeline test","threat_assessment":"none"}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--skip-rpc") { skipRpc = true; continue; }
    if (a === "--roster-size" && argv[i + 1]) { rosterSize = Number(argv[++i]); continue; }
  }
  return { skipRpc, rosterSize, promptText };
}

interface Result {
  stage: string;
  ok: boolean;
  durationMs: number;
  detail: string;
}

const results: Result[] = [];

async function timed<T>(stage: string, fn: () => Promise<{ detail: string; value?: T }>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const durationMs = Date.now() - t0;
    results.push({ stage, ok: true, durationMs, detail: r.detail });
    console.log(`  ✓ ${stage.padEnd(8)} ${durationMs}ms — ${r.detail}`);
    return r.value ?? null;
  } catch (e) {
    const durationMs = Date.now() - t0;
    const detail = (e as Error).message;
    results.push({ stage, ok: false, durationMs, detail });
    console.log(`  ✗ ${stage.padEnd(8)} ${durationMs}ms — FAIL: ${detail}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("[pipeline] sim-wars pre-flight checks\n");

  // 1. ENV
  await timed("ENV", async () => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY not set (check root .env)");
    if (!key.startsWith("sk-or-")) {
      throw new Error(`OPENROUTER_API_KEY does not look like an OpenRouter key (starts with "${key.slice(0, 6)}…")`);
    }
    const presets = {
      agent: process.env.OPENROUTER_AGENT_PRESET,
      boost: process.env.OPENROUTER_BOOST_PRESET,
      report: process.env.OPENROUTER_REPORT_PRESET,
    };
    const missing = Object.entries(presets).filter(([_, v]) => !v).map(([k]) => k);
    const detail = `key=${key.slice(0, 12)}… presets={agent:${presets.agent}, boost:${presets.boost}, report:${presets.report}}`;
    if (missing.length) {
      console.warn(`    (warning: missing OPENROUTER_${missing.map((m) => m.toUpperCase()).join(", OPENROUTER_")}_PRESET — falling back to LLM_MODEL)`);
    }
    return { detail };
  });

  // 2. LLM — health check + a single round-trip JSON response
  await timed("LLM", async () => {
    const llm = buildLLMClient();
    const healthy = await llm.healthCheck();
    if (!healthy) throw new Error(`health check failed (${llm.name})`);
    const raw = await llm.generateRaw(args.promptText, { maxTokens: 128 });
    if (!raw || raw.length === 0) throw new Error("empty response");
    // Must contain at least an action field — sanity check the model is following directions.
    if (!/"action"\s*:/.test(raw)) {
      throw new Error(`response did not contain "action" field: ${raw.slice(0, 200)}`);
    }
    return { detail: `${llm.name} round-trip ok (${raw.length} chars)` };
  });

  // 3. NORM — normalize a deliberately-sparse config and check the defaults landed.
  await timed("NORM", async () => {
    const sparse = {
      token: { totalSupply: 3_030_000_000 },
      // amm intentionally empty — repro of the bug from the prior e2e run
      amm: {},
      veToken: { enabled: true, maxLockMonths: 48 },
    };
    const normalized = normalizeConfig(sparse);
    if (normalized.amm.initialPrice <= 0) {
      throw new Error(`amm.initialPrice not defaulted (got ${normalized.amm.initialPrice})`);
    }
    if (normalized.amm.initialLiquidity <= 0) {
      throw new Error(`amm.initialLiquidity not defaulted (got ${normalized.amm.initialLiquidity})`);
    }
    if (!normalized.veToken?.enabled) throw new Error(`veToken.enabled lost`);
    if (normalized.veToken.maxLockMonths !== 48) {
      throw new Error(`veToken.maxLockMonths lost (${normalized.veToken.maxLockMonths})`);
    }
    return { detail: `defaults filled: amm.initialPrice=${normalized.amm.initialPrice}, governance.quorumPercent=${normalized.governance.quorumPercent}` };
  });

  // 4. ROSTER — expand to the requested size
  await timed("ROSTER", async () => {
    const roster = expandRoster({ count: args.rosterSize, preset: "balanced", simId: "pipeline-test" });
    if (roster.length === 0) throw new Error("expander produced zero agents");
    if (Math.abs(roster.length - args.rosterSize) > args.rosterSize * 0.05) {
      throw new Error(`roster size off by >5%: requested ${args.rosterSize}, got ${roster.length}`);
    }
    const ids = new Set(roster.map((a) => a.id));
    if (ids.size !== roster.length) throw new Error("duplicate agent IDs in roster");
    const types = new Set(roster.map((a) => a.type));
    return { detail: `${roster.length} agents, ${types.size} archetypes (target ${args.rosterSize})` };
  });

  // 5. RPC — connection + deployer balance (skip with --skip-rpc)
  if (args.skipRpc) {
    console.log(`  - RPC      skipped (--skip-rpc)`);
  } else {
    await timed("RPC", async () => {
      const url = resolveRpcUrl();
      const conn = getConnection();
      const slot = await conn.getSlot();
      const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
      const { loadKeypair } = await import("../src/chain/connection");
      const kp = loadKeypair(walletPath);
      const balance = await conn.getBalance(kp.publicKey);
      const sol = balance / LAMPORTS_PER_SOL;
      if (sol < 0.5) {
        throw new Error(`deployer ${kp.publicKey.toBase58()} has only ${sol} SOL — fund first`);
      }
      return { detail: `${url} slot=${slot}, deployer=${sol.toFixed(2)} SOL` };
    });
  }

  // ── summary
  console.log();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.reduce((s, r) => s + r.durationMs, 0);
  console.log(`[pipeline] ${passed} passed, ${failed} failed, ${total}ms total`);
  if (failed > 0) {
    console.error(`\n[pipeline] FAILED — fix the ✗ stages above before running e2e.`);
    process.exit(1);
  }
  console.log(`[pipeline] all stages green — safe to run scripts/e2e-extract-and-sim.ts`);
}

main().catch((err) => {
  console.error("[pipeline] fatal:", err);
  process.exit(1);
});
