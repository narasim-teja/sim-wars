/**
 * End-to-end driver: PDF → extract → POST /api/sim → tail events → fetch report.
 *
 * Used to confirm the full autonomy pipeline works on a real whitepaper:
 *   bun run scripts/e2e-extract-and-sim.ts --pdf marinade.pdf --agents 50 --preset marinade [--on-chain]
 *
 * Prerequisites (you provide these):
 *   - frontend dev server running on :3000 (for the /api/extract/source route)
 *   - sim-engine API server running on :8787 (POST /api/sim, GET /api/sim/:id/report)
 *   - OPENROUTER_API_KEY + OPENROUTER_EXTRACTION_PRESET set in frontend/.env.local
 *   - With --on-chain: solana-test-validator running, OR ANCHOR_PROVIDER_URL pointed
 *     at devnet with a funded deployer wallet
 *
 * The script is intentionally thin — every step is a real HTTP call you could
 * also make with curl. It exists so you can do a 1-liner "does the whole thing
 * actually work end-to-end" sanity check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Args {
  pdfPath: string;
  agentCount: number;
  rosterPreset: "luna" | "marinade" | "jito" | "balanced";
  onChain: boolean;
  ticks: number;
  pollTimeoutMs: number;
  frontendBase: string;
  simBase: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  let pdfPath = "";
  let agentCount = 50;
  let rosterPreset: Args["rosterPreset"] = "balanced";
  let onChain = false;
  let ticks = 30;
  let pollTimeoutMs = 30 * 60 * 1000; // 30 min default; on-chain runs are slow
  let frontendBase = process.env.FRONTEND_BASE ?? "http://localhost:3000";
  let simBase = process.env.SIM_BASE ?? "http://localhost:8787";
  let outDir = "./.local/e2e";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pdf" && argv[i + 1]) { pdfPath = argv[++i]!; continue; }
    if (a === "--agents" && argv[i + 1]) { agentCount = Number(argv[++i]); continue; }
    if (a === "--preset" && argv[i + 1]) { rosterPreset = argv[++i] as Args["rosterPreset"]; continue; }
    if (a === "--on-chain") { onChain = true; continue; }
    if (a === "--ticks" && argv[i + 1]) { ticks = Number(argv[++i]); continue; }
    if (a === "--poll-timeout-ms" && argv[i + 1]) { pollTimeoutMs = Number(argv[++i]); continue; }
    if (a === "--frontend" && argv[i + 1]) { frontendBase = argv[++i]!; continue; }
    if (a === "--sim" && argv[i + 1]) { simBase = argv[++i]!; continue; }
    if (a === "--out" && argv[i + 1]) { outDir = argv[++i]!; continue; }
  }
  if (!pdfPath) {
    console.error("usage: bun run scripts/e2e-extract-and-sim.ts --pdf <path> [--agents N] [--preset luna|marinade|jito|balanced] [--on-chain] [--ticks N] [--poll-timeout-ms N]");
    process.exit(2);
  }
  return { pdfPath: resolve(pdfPath), agentCount, rosterPreset, onChain, ticks, pollTimeoutMs, frontendBase, simBase, outDir };
}

async function extract(args: Args): Promise<unknown> {
  if (!existsSync(args.pdfPath)) throw new Error(`PDF not found: ${args.pdfPath}`);
  const buf = readFileSync(args.pdfPath);
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)], { type: "application/pdf" }), args.pdfPath.split("/").pop());
  const res = await fetch(`${args.frontendBase}/api/extract/source`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`extract failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

interface CreateSimResponse { simId: string; agentCount: number }

async function createSim(args: Args, config: unknown): Promise<CreateSimResponse> {
  const body = {
    config,
    agentCount: args.agentCount,
    rosterPreset: args.rosterPreset,
    tickConfig: { intervalMs: 0, maxTicks: args.ticks },
    onChain: args.onChain,
  };
  const res = await fetch(`${args.simBase}/api/sim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createSim failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json() as Promise<CreateSimResponse>;
}

async function pollUntilDone(args: Args, simId: string, timeoutMs = args.pollTimeoutMs): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${args.simBase}/api/sim/${simId}`);
    if (res.ok) {
      const snap = (await res.json()) as { status: string; tick: number; hasReport: boolean };
      console.log(`  status=${snap.status} tick=${snap.tick} hasReport=${snap.hasReport}`);
      if (snap.hasReport) return snap.status;
      if (snap.status === "failed") throw new Error("sim failed before report ready");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for report`);
}

async function fetchReport(args: Args, simId: string): Promise<unknown> {
  const res = await fetch(`${args.simBase}/api/sim/${simId}/report`);
  if (!res.ok) throw new Error(`fetchReport failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(args.outDir, { recursive: true });

  console.log(`[e2e] 1/4 extracting ${args.pdfPath}…`);
  const outcome = await extract(args);
  writeFileSync(`${args.outDir}/extraction.json`, JSON.stringify(outcome, null, 2));
  const protocolName = (outcome as { protocolName?: string }).protocolName ?? "(unknown)";
  const protocolKind = (outcome as { protocolKind?: string }).protocolKind ?? "(unknown)";
  const confidence = (outcome as { confidence?: number }).confidence ?? null;
  console.log(`[e2e]    protocolName="${protocolName}" kind=${protocolKind} confidence=${confidence}`);

  const config = (outcome as { config?: unknown }).config;
  if (!config) throw new Error("extraction returned no config");

  console.log(`[e2e] 2/4 POST /api/sim (agents=${args.agentCount} preset=${args.rosterPreset} onChain=${args.onChain})…`);
  const sim = await createSim(args, config);
  console.log(`[e2e]    simId=${sim.simId} agentCount=${sim.agentCount}`);

  console.log(`[e2e] 3/4 polling for report…`);
  const finalStatus = await pollUntilDone(args, sim.simId);

  console.log(`[e2e] 4/4 fetching report…`);
  const report = await fetchReport(args, sim.simId);
  writeFileSync(`${args.outDir}/report.json`, JSON.stringify(report, null, 2));

  const summary = {
    simId: sim.simId,
    finalStatus,
    protocolName,
    protocolKind,
    extractionConfidence: confidence,
    resilienceScore: (report as { resilienceScore?: number }).resilienceScore ?? null,
    resilienceGrade: (report as { resilienceGrade?: string }).resilienceGrade ?? null,
    deathSpiralDetected: ((report as { meta?: { deathSpiralDetected?: boolean } }).meta ?? {}).deathSpiralDetected ?? null,
  };
  writeFileSync(`${args.outDir}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`[e2e] done — wrote ${args.outDir}/{extraction,report,summary}.json`);
  console.log(`[e2e] summary:`, summary);
}

main().catch((err) => {
  console.error("[e2e] failed:", err);
  process.exit(1);
});
