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
  healthCheck(): Promise<boolean>;
  listModels?(): Promise<string[]>;
}
