import type { LLMResponse } from "../../types";
import type { LLMClient, LLMBatchItem, LLMGenerateOptions } from "../types";
import { parseLLMResponse, DEFAULT_HOLD } from "../parse";

export interface OllamaProviderOptions {
  model?: string;
  baseUrl?: string;
}

export class OllamaProvider implements LLMClient {
  readonly name: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: OllamaProviderOptions = {}) {
    this.model = opts.model ?? process.env.LLM_MODEL ?? "qwen3:8b";
    this.baseUrl = opts.baseUrl ?? process.env.LLM_BASE_URL ?? "http://localhost:11434";
    this.name = `ollama:${this.model}`;
  }

  async generate(prompt: string, opts: LLMGenerateOptions = {}): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: opts.jsonMode === false ? undefined : "json",
        options: {
          temperature: opts.temperature ?? 0.3,
          num_predict: opts.maxTokens ?? 512,
          top_p: 0.9,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ollama ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { response: string };
    return parseLLMResponse(data.response);
  }

  async generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>> {
    const results = new Map<string, LLMResponse>();
    await Promise.all(
      items.map(async ({ agentId, prompt }) => {
        try {
          results.set(agentId, await this.generate(prompt));
        } catch (err) {
          console.error(`  [${this.name}] error for ${agentId}:`, (err as Error).message);
          results.set(agentId, { ...DEFAULT_HOLD, reasoning: `llm_error: ${(err as Error).message}` });
        }
      }),
    );
    return results;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }
}
