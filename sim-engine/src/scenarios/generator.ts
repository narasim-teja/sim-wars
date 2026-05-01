import type { LLMClient } from "../llm/types";
import type { SimulationConfig } from "../types";
import { parseLLMResponse } from "../llm/parse";

export interface ScenarioDraft {
  config: SimulationConfig;
  rationale: Record<string, string>;
}

const DRAFT_PROMPT = (goal: string) => `You are a DeFi simulation architect. Given a research goal, draft a SimulationConfig
JSON that will realistically reproduce or probe the dynamic described. Choose numbers that
make the failure mode visible inside ~30 ticks.

GOAL: ${goal}

Output JSON with two top-level keys, 'config' and 'rationale'. 'config' must match this shape exactly:

{
  "token":      { "totalSupply": number, "decimals": 6, "allocations": [{ "name": string, "percent": number, "vestingMonths": number }] },
  "staking":    { "baseAPY": number, "maxAPY": number, "lockPeriodTicks": number, "unstakePenaltyPercent": number },
  "amm":        { "initialLiquidity": number, "initialPrice": number, "feeTier": number },
  "governance": { "proposalThresholdPercent": number, "quorumPercent": number, "votingPeriodTicks": number, "timelockTicks": number },
  "stablecoin": { "enabled": boolean, "targetPeg": number, "mintBurnRatio": number, "reserveAmount": number }
}

'rationale' is a flat object mapping each top-level field ('token', 'staking', 'amm',
'governance', 'stablecoin') to a single-sentence explanation of why those numbers were chosen.

Return ONLY JSON. No markdown, no prose outside the JSON.`;

/**
 * Draft a SimulationConfig from a plain-English goal. Returns the parsed
 * config + the LLM's per-field rationale so the UI can display *why* each
 * number was picked (MiroFish's simulation_config_generator pattern).
 *
 * Uses the LLM's raw `generate()` API rather than the agent-decision parser
 * because the schema here is config-shaped, not action-shaped.
 */
export async function draftScenario(
  llm: LLMClient,
  goal: string,
): Promise<ScenarioDraft> {
  const prompt = DRAFT_PROMPT(goal);
  // generate() returns LLMResponse typed for agent decisions, but for this
  // use case we want the raw text — so we call a separate helper that
  // grabs the raw completion, then parse it ourselves.
  const raw = await callRaw(llm, prompt);
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`scenario generator: unparseable LLM output: ${raw.slice(0, 200)}`);
  }
  const config = (parsed as { config?: unknown }).config;
  const rationale = (parsed as { rationale?: unknown }).rationale;
  if (!isSimulationConfig(config)) {
    throw new Error(`scenario generator: config did not match SimulationConfig shape`);
  }
  return {
    config,
    rationale: (rationale && typeof rationale === "object" ? rationale : {}) as Record<string, string>,
  };
}

async function callRaw(llm: LLMClient, prompt: string): Promise<string> {
  return llm.generateRaw(prompt, { maxTokens: 2048 });
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const tryParse = (s: string) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const slice = trimmed.slice(braceStart, braceEnd + 1);
    const s = tryParse(slice);
    if (s) return s;
  }
  return null;
}

function isSimulationConfig(x: unknown): x is SimulationConfig {
  if (!x || typeof x !== "object") return false;
  const c = x as Partial<SimulationConfig>;
  return (
    !!c.token && typeof c.token.totalSupply === "number" &&
    !!c.staking && typeof c.staking.baseAPY === "number" &&
    !!c.amm && typeof c.amm.initialPrice === "number" &&
    !!c.governance && typeof c.governance.quorumPercent === "number"
  );
}
