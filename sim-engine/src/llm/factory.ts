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
}

/**
 * Resolve env → concrete LLMClient. Wraps primary+boost in a RoutingLLMClient
 * when a boost is configured.
 */
export function buildLLMClient(opts: BuildLLMOptions = {}): LLMClient {
  const primary = makeProvider({
    provider: opts.provider ?? (process.env.LLM_PROVIDER as LLMProviderKind | undefined) ?? "ollama",
    model: opts.model,
    baseUrl: opts.baseUrl,
  });

  const boost = resolveBoost(opts.boost);
  if (!boost) return primary;
  return new RoutingLLMClient(primary, boost);
}

function makeProvider(args: { provider: LLMProviderKind; model?: string; baseUrl?: string; apiKey?: string }): LLMClient {
  switch (args.provider) {
    case "ollama":
      return new OllamaProvider({ model: args.model, baseUrl: args.baseUrl });
    case "openrouter":
      return new OpenRouterProvider({ model: args.model, baseUrl: args.baseUrl, apiKey: args.apiKey });
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
    });
  }
  const kind = process.env.LLM_BOOST_PROVIDER as LLMProviderKind | undefined;
  if (!kind) return null;
  return makeProvider({
    provider: kind,
    model: process.env.LLM_BOOST_MODEL,
    baseUrl: process.env.LLM_BOOST_BASE_URL,
    apiKey: process.env.LLM_BOOST_API_KEY,
  });
}
