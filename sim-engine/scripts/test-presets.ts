/**
 * Smoke-test all four OpenRouter presets against realistic prompts before
 * spending money on a full sim. Catches the common failure modes early:
 *
 *   - preset slug typo'd / not yet active on the dashboard → 4xx
 *   - model wraps output in markdown fences (3B-class often does this)
 *   - model omits required JSON keys (Mistral 3B sometimes drops "amount")
 *   - JSON mode silently downgrades to plain text
 *
 * Usage:
 *   bun run scripts/test-presets.ts
 *
 * Reads OPENROUTER_API_KEY + the four preset slugs from process.env.
 * Hydrates env from frontend/.env.local + root .env if either is present.
 *
 * Output: per-preset PASS/WARN/FAIL with timing, token usage, and a snippet
 * of the parsed/raw response. Exit 0 if every required preset passes, 1
 * otherwise. The boost preset is treated as optional.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

// ---- env hydration --------------------------------------------------------

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf-8");
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// Load order: frontend overrides root for OPENROUTER_API_KEY, since that's
// the file the user is most likely to have a real key in.
loadDotenv(resolve(ROOT, ".env"));
loadDotenv(resolve(ROOT, "frontend/.env.local"));

const API_KEY = process.env.OPENROUTER_API_KEY;
const PRESETS = {
  extraction: process.env.OPENROUTER_EXTRACTION_PRESET ?? null,
  agent: process.env.OPENROUTER_AGENT_PRESET ?? null,
  boost: process.env.OPENROUTER_BOOST_PRESET ?? null,
  report: process.env.OPENROUTER_REPORT_PRESET ?? null,
};

if (!API_KEY) {
  console.error("✗ OPENROUTER_API_KEY missing — set it in root .env or frontend/.env.local");
  process.exit(1);
}

// ---- test definitions ----------------------------------------------------

interface PresetTest {
  label: string;
  preset: string;
  required: boolean;
  prompt: string;
  maxTokens: number;
  /** Validate the parsed JSON has the keys the engine expects. Returns null on success, error string on failure. */
  validate: (json: unknown, raw: string) => string | null;
}

// 1. EXTRACTION — Curve-style mini-whitepaper. Validate it returns a config
//    with at least token + staking sections.
const EXTRACTION_PROMPT = `You are extracting DeFi tokenomics parameters from a whitepaper / docs to seed a multi-agent stress-test simulation.

Return ONLY a JSON object with this shape:
{
  "config": {
    "token": { "totalSupply": <number>, "decimals": <int>, "allocations": [{"name":<string>,"percent":<0-100>,"vestingMonths":<int>,"cliffMonths":<int>}] },
    "staking": { "baseAPY": <number>, "lockPeriodTicks": <int> }
  },
  "protocolName": <string>,
  "protocolKind": "veToken",
  "confidence": <0-1>
}

SOURCE (test fixture):
<<<
TestProto is a vote-escrow governance token. Total supply is 100 million TST tokens, 6 decimals.
Allocation:
  - Team: 20%, vested over 48 months with a 12-month cliff.
  - Investors: 15%, vested over 24 months with a 6-month cliff.
  - Treasury: 25%, unlocked at TGE.
  - Liquidity: 40%, unlocked at TGE.

Stakers lock TST for up to 4 years to earn veTST. Base APY is 8%, scaling linearly with lock duration.
>>>`;

// 2. AGENT — realistic per-tick prompt, expect {action, amount, reasoning, threat_assessment}.
const AGENT_PROMPT = `You are The Whale in a live token economy simulation on Solana devnet.

YOUR IDENTITY AND GOALS:
You are a sophisticated whale holding 5% of supply. You are rational and profit-motivated. Your goal is to maximize exit value.

NUMERIC DECISION TRIGGERS:
- If reserve depleted > 15% OR peg < 0.995: UNSTAKE all, then SELL 25% of tokens this tick.
- If price has fallen > 20% from your entry ($85): SELL 75% immediately.

CURRENT MARKET STATE (Tick 12):
- Token price: $62.50 (was $85.00 five ticks ago)
- Price trend: CRASHING (-26.5%)
- Your holdings: 30,000,000 tokens, 20,000,000 staked, $5,000,000 USDC
- Staking APY: 19.45% (WARNING: unsustainably high)
- Total staked: 45.0% of supply
- Wealth concentration (Gini): 0.74 - HIGH CENTRALIZATION
- STABLECOIN PEG: $0.9821 — BREAKING — peg below 0.99
- Reserve depleted: 22.50% since start ⚠ RESERVE BLEEDING
- Recent large trades: FARMER_01 unstake 18,000,000; DEGEN_02 sell 4,500,000

YOUR RECENT ACTIONS: [T8] hold null - watching peg | [T10] hold null - waiting for clear signal
OTHER AGENTS RECENTLY: FARMER_01: unstake 18000000, DEGEN_02: sell 4500000

CONSTRAINTS:
- You can only sell/unstake what you hold

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "buy" | "sell" | "stake" | "unstake" | "propose" | "vote_yes" | "vote_no" | "hold" | "burn_stablecoin",
  "amount": <number, or null for hold>,
  "reasoning": "<1-2 sentence explanation>",
  "threat_assessment": "<what failure mode do you sense, if any>"
}`;

// 3. REPORT — small fake-sim summary, expect {executiveSummary, failureModes, recommendations}.
const REPORT_PROMPT = `You are an adversarial DeFi auditor writing the post-mortem for a tokenomics simulation that just finished.

OUTCOME: 20-agent LUNA backtest. Final price $0.12 (initial $85). Death spiral confirmed at tick 28. Reserve depleted 95%.

Produce a JSON object:
{
  "executiveSummary": <string, 2-3 sentences>,
  "failureModes": [{ "name": <string>, "severity": <0-100>, "description": <string> }],
  "recommendations": [{ "parameter": <string>, "suggestedValue": <string>, "rationale": <string> }]
}

Output ONLY JSON. No markdown.`;

const TESTS: PresetTest[] = [];
if (PRESETS.extraction) {
  TESTS.push({
    label: "extraction (whitepaper → SimulationConfig)",
    preset: PRESETS.extraction,
    required: true,
    prompt: EXTRACTION_PROMPT,
    maxTokens: 1024,
    validate: (json) => {
      const obj = json as Record<string, unknown>;
      const cfg = obj?.config as Record<string, unknown> | undefined;
      if (!cfg) return "missing 'config' key";
      if (!cfg.token) return "missing 'config.token'";
      const allocs = (cfg.token as Record<string, unknown>).allocations;
      if (!Array.isArray(allocs)) return "config.token.allocations not an array";
      const hasCliff = allocs.some((a) => typeof (a as Record<string, unknown>).cliffMonths === "number");
      if (!hasCliff) return "no allocation has cliffMonths — model didn't extract cliffs";
      return null;
    },
  });
}
if (PRESETS.agent) {
  TESTS.push({
    label: "agent-decisions (per-tick action JSON)",
    preset: PRESETS.agent,
    required: true,
    prompt: AGENT_PROMPT,
    maxTokens: 256,
    validate: validateAgentDecision,
  });
}
if (PRESETS.boost) {
  TESTS.push({
    label: "agent-decisions-fast (boost preset, smaller model)",
    preset: PRESETS.boost,
    required: false,
    prompt: AGENT_PROMPT,
    maxTokens: 256,
    validate: validateAgentDecision,
  });
}
if (PRESETS.report) {
  TESTS.push({
    label: "report-writer (post-sim narrative)",
    preset: PRESETS.report,
    required: true,
    prompt: REPORT_PROMPT,
    maxTokens: 1500,
    validate: (json) => {
      const obj = json as Record<string, unknown>;
      if (typeof obj.executiveSummary !== "string") return "missing executiveSummary string";
      if (!Array.isArray(obj.failureModes)) return "failureModes not an array";
      if (!Array.isArray(obj.recommendations)) return "recommendations not an array";
      return null;
    },
  });
}

function validateAgentDecision(json: unknown): string | null {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== "object") return "not a JSON object";
  const VALID = ["buy","sell","stake","unstake","vote_yes","vote_no","propose","hold","burn_stablecoin"];
  if (typeof obj.action !== "string") return "missing 'action' string";
  if (!VALID.includes(obj.action)) return `unrecognized action: ${obj.action}`;
  if (obj.amount !== null && typeof obj.amount !== "number") return "'amount' must be number or null";
  if (typeof obj.reasoning !== "string") return "missing 'reasoning' string";
  if (typeof obj.threat_assessment !== "string") return "missing 'threat_assessment' string";
  return null;
}

// ---- runner --------------------------------------------------------------

interface CallResult {
  raw: string;
  modelResolved: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  parsed: unknown | null;
  parseStrategy: "direct" | "fence-stripped" | "brace-extract" | "failed";
}

async function callPreset(preset: string, prompt: string, maxTokens: number): Promise<CallResult> {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Title": "sim-wars-preset-test",
    },
    body: JSON.stringify({
      model: `@preset/${preset}`,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
    }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

  const { parsed, strategy } = tryParse(raw);
  return {
    raw,
    modelResolved: data.model ?? `(preset ${preset})`,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    ms,
    parsed,
    parseStrategy: strategy,
  };
}

function tryParse(raw: string): { parsed: unknown | null; strategy: CallResult["parseStrategy"] } {
  // 1. Direct.
  try { return { parsed: JSON.parse(raw), strategy: "direct" }; } catch { /* fall */ }
  // 2. Strip ``` fences.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return { parsed: JSON.parse(fence[1]!.trim()), strategy: "fence-stripped" }; } catch { /* fall */ }
  }
  // 3. Outer-brace extraction.
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return { parsed: JSON.parse(brace[0]), strategy: "brace-extract" }; } catch { /* fall */ }
  }
  return { parsed: null, strategy: "failed" };
}

// ---- main ----------------------------------------------------------------

function fmtUsd(promptT: number, completionT: number, inP: number, outP: number): string {
  const cents = (promptT * inP + completionT * outP) / 1000;
  return `$${(cents / 1000).toFixed(6)}`;
}

async function main(): Promise<number> {
  if (TESTS.length === 0) {
    console.error("✗ No presets configured. Set OPENROUTER_AGENT_PRESET / OPENROUTER_REPORT_PRESET / etc.");
    return 1;
  }

  console.log(`Testing ${TESTS.length} preset(s) against ${API_KEY!.slice(0, 12)}…\n`);

  let failures = 0;
  for (const test of TESTS) {
    process.stdout.write(`▸ ${test.label}\n  preset: @preset/${test.preset}\n`);
    try {
      const r = await callPreset(test.preset, test.prompt, test.maxTokens);
      const valErr = r.parsed !== null ? test.validate(r.parsed, r.raw) : `JSON parse failed (strategy=${r.parseStrategy})`;
      const verdict = !valErr ? (r.parseStrategy === "direct" ? "✓ PASS" : "⚠ PASS (recoverable)") : "✗ FAIL";
      console.log(`  model:    ${r.modelResolved}`);
      console.log(`  latency:  ${r.ms} ms`);
      console.log(`  tokens:   ${r.promptTokens} in / ${r.completionTokens} out`);
      console.log(`  parse:    ${r.parseStrategy}`);
      console.log(`  ${verdict}${valErr ? `  reason: ${valErr}` : ""}`);
      if (r.parseStrategy !== "direct" && r.parsed) {
        // Show the leading non-JSON noise so the user can see what the model did.
        const firstBrace = r.raw.indexOf("{");
        const prefix = firstBrace > 0 ? r.raw.slice(0, firstBrace) : "";
        if (prefix.trim()) console.log(`  leading-noise: ${JSON.stringify(prefix.slice(0, 80))}`);
      }
      if (!r.parsed) {
        console.log(`  raw[:200]: ${JSON.stringify(r.raw.slice(0, 200))}`);
      } else {
        const preview = JSON.stringify(r.parsed).slice(0, 220);
        console.log(`  parsed:   ${preview}${preview.length >= 220 ? "…" : ""}`);
      }
      if (valErr && test.required) failures += 1;
      if (valErr && !test.required) console.log("  (this preset is OPTIONAL — sim falls back to primary)");
    } catch (e) {
      console.log(`  ✗ FAIL  reason: ${(e as Error).message}`);
      if (test.required) failures += 1;
    }
    console.log();
  }

  if (failures > 0) {
    console.log(`✗ ${failures} required preset(s) failing — fix before running a real sim.`);
    return 1;
  }
  console.log(`✓ All required presets passed.`);
  return 0;
}

const code = await main();
process.exit(code);
