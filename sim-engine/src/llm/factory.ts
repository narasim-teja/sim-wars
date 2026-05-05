import type { LLMClient } from "./types";
import { OpenRouterProvider } from "./providers/openrouter-provider";
import { MockProvider } from "./providers/mock-provider";
import { RoutingLLMClient } from "./routing-client";

/**
 * Single OpenRouter-backed factory.
 *
 * Why OpenRouter-only: every previous run that "silently fell back to Ollama"
 * was a configuration accident, not a feature. Removing the local-LLM path
 * makes "no API key" a hard failure instead of a quiet degradation.
 *
 * `mock` exists only for unit tests and is never selected from env — callers
 * that want it must pass `{ provider: "mock" }` explicitly.
 */
export type LLMProviderKind = "openrouter" | "mock";

export interface BuildLLMOptions {
  /** Override provider kind. Default = openrouter. `mock` is for tests only. */
  provider?: LLMProviderKind;
  /** Override primary model id. Default: env LLM_MODEL. */
  model?: string;
  /** Override base URL. Default: env LLM_BASE_URL. */
  baseUrl?: string;
  /**
   * OpenRouter preset slug for primary calls. Defaults to env
   * OPENROUTER_AGENT_PRESET.
   */
  preset?: string;
  /** Boost provider for `complexity: "fast"` agents. Pass null to disable. */
  boost?: TierConfig | null;
  /** Reasoning provider for `complexity: "reasoning"` agents. Pass null to disable. */
  reasoning?: TierConfig | null;
}

export interface TierConfig {
  model?: string;
  preset?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** @deprecated alias kept for callers that still import BoostConfig. */
export type BoostConfig = TierConfig;

/**
 * Build the agent-decision LLM client. OpenRouter only.
 *
 * Preset routing (env-driven):
 *   - primary:   OPENROUTER_AGENT_PRESET
 *   - boost:     OPENROUTER_BOOST_PRESET — used for `complexity: "fast"`
 *   - reasoning: OPENROUTER_REASONING_PRESET — used for `complexity: "reasoning"`
 *   - report:    OPENROUTER_REPORT_PRESET — used by buildReportLLMClient
 *
 * If neither boost nor reasoning is configured, returns the bare primary
 * client (no router wrapper). Otherwise returns a RoutingLLMClient that
 * fans out to the configured tiers in parallel.
 */
export function buildLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  const providerKind = opts.provider ?? "openrouter";
  if (providerKind === "mock") return new MockProvider();

  const primary = new OpenRouterProvider({
    model: opts.model,
    baseUrl: opts.baseUrl,
    preset: opts.preset ?? process.env.OPENROUTER_AGENT_PRESET,
  });

  const boost = resolveTier(opts.boost, "OPENROUTER_BOOST_PRESET");
  const reasoning = resolveTier(opts.reasoning, "OPENROUTER_REASONING_PRESET");
  if (!boost && !reasoning) return primary;
  return new RoutingLLMClient(primary, { primary, boost, reasoning });
}

/**
 * Build the post-sim report LLM client. Uses `OPENROUTER_REPORT_PRESET` when
 * available so the report can run on a higher-quality model (Gemini 3 Flash,
 * Sonnet, etc.) while agent decisions stay on the cheap preset.
 */
export function buildReportLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  if (opts.provider === "mock") return new MockProvider();
  const reportPreset = process.env.OPENROUTER_REPORT_PRESET;
  if (!reportPreset) return buildLLMClient(opts);
  return new OpenRouterProvider({ preset: reportPreset });
}

/**
 * Resolve a tier (boost or reasoning):
 *   - explicit `null` from caller → tier disabled.
 *   - explicit config object → instantiate with those settings.
 *   - otherwise → look up the env var; if set, use it; if not, return null.
 */
function resolveTier(override: TierConfig | null | undefined, envVar: string): LLMClient | null {
  if (override === null) return null;
  if (override) {
    return new OpenRouterProvider({
      model: override.model,
      baseUrl: override.baseUrl,
      apiKey: override.apiKey,
      preset: override.preset,
    });
  }
  const preset = process.env[envVar];
  if (!preset) return null;
  return new OpenRouterProvider({ preset });
}
