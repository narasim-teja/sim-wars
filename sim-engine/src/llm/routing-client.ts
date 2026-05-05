import type { LLMResponse } from "../types";
import type { LLMClient, LLMBatchItem, AgentComplexity, LLMGenerateOptions, LLMUsage } from "./types";
import { ZERO_USAGE, addUsage } from "./types";

export interface RoutingClients {
  /** Required. Default lane for `standard` complexity (and the fall-through). */
  primary: LLMClient;
  /** Optional cheap model lane for `complexity: "fast"`. Falls through to primary when unset. */
  boost?: LLMClient | null;
  /** Optional stronger model lane for `complexity: "reasoning"`. Falls through to primary when unset. */
  reasoning?: LLMClient | null;
}

/**
 * Three-tier LLM router driven by `LLMBatchItem.complexity`.
 *
 *   complexity: "fast"      → boost     (cheap/fast model — retail, farmers)
 *   complexity: "standard"  → primary   (default)
 *   complexity: "reasoning" → reasoning (stronger model — coordinated attacks,
 *                                        governance proposals, treasury defense)
 *
 * Each tier is independently cost-tunable via OpenRouter presets. Tiers
 * fan out concurrently inside a tick — fast/standard/reasoning lanes
 * dispatch their items in parallel, so adding a tier doesn't add latency
 * unless the slowest lane gets slower.
 *
 * Backward-compatible: a missing tier (boost or reasoning) routes back to
 * primary. A two-arg constructor `new RoutingLLMClient(primary, boost)`
 * still works for callers that haven't migrated yet.
 */
export class RoutingLLMClient implements LLMClient {
  readonly name: string;
  private primary: LLMClient;
  private boost: LLMClient | null;
  private reasoning: LLMClient | null;

  constructor(primary: LLMClient, boostOrClients?: LLMClient | null | RoutingClients) {
    if (boostOrClients && typeof boostOrClients === "object" && "primary" in boostOrClients) {
      // New shape: RoutingClients object. The `primary` field on it is
      // ignored in favor of the explicit positional `primary` arg, which
      // keeps a single source of truth.
      this.primary = primary;
      this.boost = boostOrClients.boost ?? null;
      this.reasoning = boostOrClients.reasoning ?? null;
    } else {
      // Legacy shape: (primary, boost?) — reasoning falls through to primary.
      this.primary = primary;
      this.boost = (boostOrClients as LLMClient | null | undefined) ?? null;
      this.reasoning = null;
    }
    const lanes: string[] = [`primary=${this.primary.name}`];
    if (this.boost) lanes.push(`boost=${this.boost.name}`);
    if (this.reasoning) lanes.push(`reasoning=${this.reasoning.name}`);
    this.name = `router[${lanes.join(", ")}]`;
  }

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    return this.primary.generate(prompt, opts);
  }

  async generateRaw(prompt: string, opts?: LLMGenerateOptions): Promise<string> {
    return this.primary.generateRaw(prompt, opts);
  }

  async generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>> {
    // Bucket by complexity; fall through to primary for tiers that aren't
    // configured, so a single-tier deployment doesn't lose items.
    const fastItems: LLMBatchItem[] = [];
    const standardItems: LLMBatchItem[] = [];
    const reasoningItems: LLMBatchItem[] = [];
    for (const item of items) {
      if (item.complexity === "fast" && this.boost) fastItems.push(item);
      else if (item.complexity === "reasoning" && this.reasoning) reasoningItems.push(item);
      else standardItems.push(item);
    }

    const lanes: Promise<Map<string, LLMResponse>>[] = [];
    if (standardItems.length) lanes.push(this.primary.generateBatch(standardItems));
    if (fastItems.length && this.boost) lanes.push(this.boost.generateBatch(fastItems));
    if (reasoningItems.length && this.reasoning) lanes.push(this.reasoning.generateBatch(reasoningItems));

    const laneResults = await Promise.all(lanes);
    const merged = new Map<string, LLMResponse>();
    for (const result of laneResults) {
      for (const [k, v] of result) merged.set(k, v);
    }
    return merged;
  }

  async healthCheck(): Promise<boolean> {
    const checks = [this.primary.healthCheck()];
    if (this.boost) checks.push(this.boost.healthCheck());
    if (this.reasoning) checks.push(this.reasoning.healthCheck());
    const results = await Promise.all(checks);
    return results.every(Boolean);
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    if (this.primary.listModels) out.push(...(await this.primary.listModels()));
    if (this.boost?.listModels) out.push(...(await this.boost.listModels()));
    if (this.reasoning?.listModels) out.push(...(await this.reasoning.listModels()));
    return out;
  }

  drainUsage(): LLMUsage {
    let total = this.primary.drainUsage?.() ?? { ...ZERO_USAGE };
    if (this.boost) total = addUsage(total, this.boost.drainUsage?.() ?? { ...ZERO_USAGE });
    if (this.reasoning) total = addUsage(total, this.reasoning.drainUsage?.() ?? { ...ZERO_USAGE });
    return total;
  }

  getPrimary(): LLMClient {
    return this.primary;
  }

  getBoost(): LLMClient | null {
    return this.boost;
  }

  getReasoning(): LLMClient | null {
    return this.reasoning;
  }

  static pickComplexity(_persona: { complexity?: AgentComplexity }): AgentComplexity {
    return _persona.complexity ?? "standard";
  }
}
