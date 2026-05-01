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
  complexity?: AgentComplexity;
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
}
