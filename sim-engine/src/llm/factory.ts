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
  boost?: BoostConfig | null;
}

export interface BoostConfig {
  model?: string;
  preset?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Build the agent-decision LLM client. OpenRouter only.
 *
 * Preset routing (env-driven):
 *   - primary: OPENROUTER_AGENT_PRESET
 *   - boost:   OPENROUTER_BOOST_PRESET (only used by RoutingLLMClient when an
 *              agent persona has `complexity: "fast"`)
 *   - report:  OPENROUTER_REPORT_PRESET (used by buildReportLLMClient)
 */
export function buildLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  const providerKind = opts.provider ?? "openrouter";
  if (providerKind === "mock") return new MockProvider();

  const primary = new OpenRouterProvider({
    model: opts.model,
    baseUrl: opts.baseUrl,
    preset: opts.preset ?? process.env.OPENROUTER_AGENT_PRESET,
  });

  const boost = resolveBoost(opts.boost);
  if (!boost) return primary;
  return new RoutingLLMClient(primary, boost);
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

function resolveBoost(override?: BoostConfig | null): LLMClient | null {
  if (override === null) return null;
  if (override) {
    return new OpenRouterProvider({
      model: override.model,
      baseUrl: override.baseUrl,
      apiKey: override.apiKey,
      preset: override.preset,
    });
  }
  const preset = process.env.OPENROUTER_BOOST_PRESET;
  if (!preset) return null;
  return new OpenRouterProvider({ preset });
}
