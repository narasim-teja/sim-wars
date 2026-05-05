import type { LLMResponse } from "../types";

export type AgentComplexity = "fast" | "standard" | "reasoning";

export interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LLMBatchItem {
  agentId: string;
  prompt: string;
  /**
   * Structured prompt zones for cache-aware providers. When present,
   * providers that support prompt caching (OpenRouter + Qwen-style explicit
   * `cache_control`) emit one cache breakpoint at the boundary between the
   * stable zones (frame, archetype) and the per-tick dynamic zone — turning
   * 80% of the prompt into cache reads from tick 2 onward.
   *
   * Providers that don't understand zones (mock, future plain-string clients)
   * ignore this field and use `prompt`, which is always a flattened string
   * version of the same content.
   */
  zones?: PromptZone[];
  complexity?: AgentComplexity;
}

/**
 * One section of the agent prompt. Concatenating zones in order yields the
 * flat `prompt` string. The `id` determines whether the zone is cacheable —
 * `frame` and `archetype` are stable across ticks; `dynamic` is per-tick
 * and must never appear before a cache breakpoint.
 *
 * Layout invariant: zones are emitted in this order: [frame, archetype, dynamic].
 * The cache breakpoint goes on the LAST cacheable zone (archetype if present,
 * else frame). Anything after it is uncached input.
 */
export interface PromptZone {
  id: "frame" | "archetype" | "dynamic";
  text: string;
}

export function flattenZones(zones: PromptZone[]): string {
  return zones.map((z) => z.text).join("\n\n");
}

/**
 * Per-call accounting drained from the provider response.
 *
 * Why: scaling to 1000+ agents makes cost/cache-hit rate the gating concern.
 * Every OpenRouter response carries a `usage` block when we ask for it; we
 * accumulate it here and let the orchestrator flush per-tick totals into the
 * sim event stream so we can A/B prompt-restructure changes against real $.
 */
export interface LLMUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export const ZERO_USAGE: LLMUsage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export interface LLMClient {
  readonly name: string;
  generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse>;
  generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>>;
  /**
   * Returns the raw model output as a string. Used by callers that want a
   * structured JSON response other than the agent-decision shape (scenario
   * generator, report generator). All providers must implement this.
   */
  generateRaw(prompt: string, opts?: LLMGenerateOptions): Promise<string>;
  healthCheck(): Promise<boolean>;
  listModels?(): Promise<string[]>;
  /**
   * Read accumulated usage since the last drain. Implementations should
   * return ZERO_USAGE if accounting is not supported (mock, providers
   * that don't echo a usage block).
   */
  drainUsage?(): LLMUsage;
}
