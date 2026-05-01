import type { LLMClient } from "./types";
import { OllamaProvider } from "./providers/ollama-provider";
import { OpenRouterProvider } from "./providers/openrouter-provider";
import { MockProvider } from "./providers/mock-provider";
import { RoutingLLMClient } from "./routing-client";

export type LLMProviderKind = "ollama" | "openrouter" | "mock";

export interface BuildLLMOptions {
  /** Override primary provider kind (default: env LLM_PROVIDER, else ollama). */
  provider?: LLMProviderKind;
  /** Override primary model (default: env LLM_MODEL). */
  model?: string;
  /** Override primary base URL (default: env LLM_BASE_URL). */
  baseUrl?: string;
  /**
   * OpenRouter preset slug for the primary provider. Defaults to
   * env `OPENROUTER_AGENT_PRESET` when provider is openrouter; only used by
   * the OpenRouter provider, ignored otherwise.
   */
  preset?: string;
  /**
   * Boost provider config. If omitted, uses LLM_BOOST_* env triplet.
   * Pass `null` to explicitly disable boost routing.
   */
  boost?: BoostConfig | null;
}

export interface BoostConfig {
  provider: LLMProviderKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** OpenRouter preset slug for the boost provider. Defaults to env OPENROUTER_BOOST_PRESET. */
  preset?: string;
}

/**
 * Resolve env → concrete LLMClient. Wraps primary+boost in a RoutingLLMClient
 * when a boost is configured.
 *
 * Preset routing (when LLM_PROVIDER=openrouter):
 *   - primary: OPENROUTER_AGENT_PRESET (cheap open model, e.g. qwen3:8b)
 *   - boost:   OPENROUTER_BOOST_PRESET (even cheaper / faster for fast personas)
 *   - report:  OPENROUTER_REPORT_PRESET (built via buildReportLLMClient — Gemini 3 Flash)
 *
 * If a preset env is unset, the provider falls back to LLM_MODEL.
 */
export function buildLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  const providerKind = opts.provider ?? (process.env.LLM_PROVIDER as LLMProviderKind | undefined) ?? "ollama";
  const primary = makeProvider({
    provider: providerKind,
    model: opts.model,
    baseUrl: opts.baseUrl,
    preset: opts.preset ?? process.env.OPENROUTER_AGENT_PRESET,
  });

  const boost = resolveBoost(opts.boost);
  if (!boost) return primary;
  return new RoutingLLMClient(primary, boost);
}

/**
 * Build a separate LLMClient for the post-sim report. Uses
 * `OPENROUTER_REPORT_PRESET` when available so the report can run on a
 * higher-quality model (e.g. Gemini 3 Flash) while agent decisions stay on
 * a cheap preset. Falls back to the same client as buildLLMClient when no
 * report preset is configured.
 */
export function buildReportLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  const reportPreset = process.env.OPENROUTER_REPORT_PRESET;
  if (!reportPreset) return buildLLMClient(opts);
  // Force OpenRouter for report — presets only exist there.
  return makeProvider({
    provider: "openrouter",
    preset: reportPreset,
  });
}

function makeProvider(args: { provider: LLMProviderKind; model?: string; baseUrl?: string; apiKey?: string; preset?: string }): LLMClient {
  switch (args.provider) {
    case "ollama":
      return new OllamaProvider({ model: args.model, baseUrl: args.baseUrl });
    case "openrouter":
      return new OpenRouterProvider({
        model: args.model,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        preset: args.preset,
      });
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${args.provider}`);
  }
}

function resolveBoost(override?: BoostConfig | null): LLMClient | null {
  if (override === null) return null;
  if (override) {
    return makeProvider({
      provider: override.provider,
      model: override.model,
      baseUrl: override.baseUrl,
      apiKey: override.apiKey,
      preset: override.preset,
    });
  }
  const kind = process.env.LLM_BOOST_PROVIDER as LLMProviderKind | undefined;
  if (!kind) return null;
  return makeProvider({
    provider: kind,
    model: process.env.LLM_BOOST_MODEL,
    baseUrl: process.env.LLM_BOOST_BASE_URL,
    apiKey: process.env.LLM_BOOST_API_KEY,
    preset: process.env.OPENROUTER_BOOST_PRESET,
  });
}
