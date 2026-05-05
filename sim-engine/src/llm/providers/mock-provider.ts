import type { LLMResponse } from "../../types";
import type { LLMClient, LLMBatchItem, LLMGenerateOptions, LLMUsage } from "../types";
import { ZERO_USAGE } from "../types";
import { DEFAULT_HOLD } from "../parse";

export type MockDecider = (args: { agentId: string; prompt: string }) => LLMResponse;

export interface MockProviderOptions {
  /** Per-agent fixed responses. */
  scripted?: Map<string, LLMResponse>;
  /** Function to generate a response dynamically. */
  decide?: MockDecider;
  /** Default response for agents not covered by `scripted` or `decide`. */
  fallback?: LLMResponse;
  /** Artificial latency per call (ms). Default 0. */
  latencyMs?: number;
  /**
   * Returns the raw text for a `generateRaw()` call. If omitted, the mock
   * returns a JSON-encoded {@link LLMResponse} so callers parsing as JSON
   * still get something valid.
   */
  rawDecide?: (prompt: string) => string;
}

/**
 * Deterministic in-process LLM for tests. No network, no tokens, no secrets.
 * Use `scripted` to pin per-agent responses or `decide` to inspect the prompt.
 */
export class MockProvider implements LLMClient {
  readonly name = "mock";
  private scripted: Map<string, LLMResponse>;
  private decide?: MockDecider;
  private fallback: LLMResponse;
  private latencyMs: number;
  private rawDecide?: (prompt: string) => string;

  public calls: { agentId: string; prompt: string }[] = [];
  private callsSinceDrain = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.scripted = opts.scripted ?? new Map();
    this.decide = opts.decide;
    this.fallback = opts.fallback ?? DEFAULT_HOLD;
    this.latencyMs = opts.latencyMs ?? 0;
    this.rawDecide = opts.rawDecide;
  }

  private recordCall(agentId: string, prompt: string): void {
    this.calls.push({ agentId, prompt });
    this.callsSinceDrain += 1;
  }

  async generate(prompt: string, _opts?: LLMGenerateOptions): Promise<LLMResponse> {
    if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
    this.recordCall("__raw__", prompt);
    if (this.decide) return this.decide({ agentId: "__raw__", prompt });
    return { ...this.fallback };
  }

  async generateRaw(prompt: string, _opts?: LLMGenerateOptions): Promise<string> {
    if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
    this.recordCall("__raw__", prompt);
    if (this.rawDecide) return this.rawDecide(prompt);
    if (this.decide) return JSON.stringify(this.decide({ agentId: "__raw__", prompt }));
    return JSON.stringify(this.fallback);
  }

  async generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>> {
    const results = new Map<string, LLMResponse>();
    for (const { agentId, prompt } of items) {
      if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
      this.recordCall(agentId, prompt);
      if (this.scripted.has(agentId)) {
        results.set(agentId, { ...this.scripted.get(agentId)! });
      } else if (this.decide) {
        results.set(agentId, this.decide({ agentId, prompt }));
      } else {
        results.set(agentId, { ...this.fallback });
      }
    }
    return results;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  drainUsage(): LLMUsage {
    // Mock has no real cost or token data, but it tracks how many calls
    // happened since the last drain so tests can assert that telemetry
    // is actually being plumbed through the orchestrator.
    const drained: LLMUsage = { ...ZERO_USAGE, calls: this.callsSinceDrain };
    this.callsSinceDrain = 0;
    return drained;
  }

  clear(): void {
    this.calls = [];
    this.callsSinceDrain = 0;
  }
}
