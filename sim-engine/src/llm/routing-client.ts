import type { LLMResponse } from "../types";
import type { LLMClient, LLMBatchItem, AgentComplexity, LLMGenerateOptions } from "./types";

/**
 * MiroFish-style "primary + boost" LLM router.
 *
 * - Primary client handles `standard` and `reasoning` personas (heavier/quality model).
 * - Boost client handles `fast` personas (cheaper/faster model).
 * - If no boost is configured, everything goes to primary.
 *
 * Same `LLMClient` shape so the orchestrator doesn't know it's routing.
 */
export class RoutingLLMClient implements LLMClient {
  readonly name: string;
  constructor(private primary: LLMClient, private boost?: LLMClient | null) {
    this.name = boost ? `router[${primary.name}|${boost.name}]` : `router[${primary.name}]`;
  }

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    return this.primary.generate(prompt, opts);
  }

  async generateRaw(prompt: string, opts?: LLMGenerateOptions): Promise<string> {
    return this.primary.generateRaw(prompt, opts);
  }

  async generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>> {
    if (!this.boost) return this.primary.generateBatch(items);

    const primaryItems: LLMBatchItem[] = [];
    const boostItems: LLMBatchItem[] = [];
    for (const item of items) {
      if (item.complexity === "fast") boostItems.push(item);
      else primaryItems.push(item);
    }

    const [primaryResults, boostResults] = await Promise.all([
      primaryItems.length ? this.primary.generateBatch(primaryItems) : Promise.resolve(new Map()),
      boostItems.length ? this.boost.generateBatch(boostItems) : Promise.resolve(new Map()),
    ]);

    const merged = new Map<string, LLMResponse>();
    for (const [k, v] of primaryResults) merged.set(k, v);
    for (const [k, v] of boostResults) merged.set(k, v);
    return merged;
  }

  async healthCheck(): Promise<boolean> {
    const checks = [this.primary.healthCheck()];
    if (this.boost) checks.push(this.boost.healthCheck());
    const results = await Promise.all(checks);
    return results.every(Boolean);
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    if (this.primary.listModels) out.push(...(await this.primary.listModels()));
    if (this.boost?.listModels) out.push(...(await this.boost.listModels()));
    return out;
  }

  getPrimary(): LLMClient {
    return this.primary;
  }

  getBoost(): LLMClient | null {
    return this.boost ?? null;
  }

  static pickComplexity(_persona: { complexity?: AgentComplexity }): AgentComplexity {
    return _persona.complexity ?? "standard";
  }
}
