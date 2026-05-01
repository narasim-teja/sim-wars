import type { LLMResponse } from "../../types";
import type { LLMClient, LLMBatchItem, LLMGenerateOptions } from "../types";
import { parseLLMResponse, DEFAULT_HOLD } from "../parse";

export interface OpenRouterProviderOptions {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** HTTP-Referer header (OpenRouter attribution), optional. */
  referer?: string;
  /** X-Title header (OpenRouter app title), optional. */
  title?: string;
  /**
   * OpenRouter preset slug. When set, the request goes to `@preset/<slug>`
   * which lets you manage model + system prompt + temperature on the
   * dashboard without code changes. Overrides `model` for the request body
   * but `model` is still kept for telemetry (`provider.name`).
   */
  preset?: string;
}

/**
 * OpenAI-compatible chat-completions client. Works against OpenRouter by default
 * but will talk to any endpoint that speaks the same schema (OpenAI, Groq,
 * Together, local vLLM, etc.) — just change `baseUrl`.
 */
export class OpenRouterProvider implements LLMClient {
  readonly name: string;
  private model: string;
  private baseUrl: string;
  private apiKey: string;
  private referer?: string;
  private title?: string;
  private preset?: string;

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.preset = opts.preset;
    this.model = opts.model ?? process.env.LLM_MODEL ?? "qwen/qwen3-8b";
    this.baseUrl = (opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";
    this.referer = opts.referer ?? process.env.OPENROUTER_REFERER;
    this.title = opts.title ?? process.env.OPENROUTER_TITLE ?? "sim-wars";
    this.name = this.preset
      ? `openrouter:@preset/${this.preset}`
      : `openrouter:${this.model}`;

    if (!this.apiKey) {
      throw new Error("OpenRouterProvider: missing API key (set OPENROUTER_API_KEY or LLM_API_KEY)");
    }
  }

  async generate(prompt: string, opts: LLMGenerateOptions = {}): Promise<LLMResponse> {
    const content = await this.generateRaw(prompt, opts);
    return parseLLMResponse(content);
  }

  async generateRaw(prompt: string, opts: LLMGenerateOptions = {}): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    // Preset request: model+system+temperature live on the dashboard. We
    // still pass max_tokens because some agent prompts need more headroom
    // than a fast/cheap preset's default.
    const body: Record<string, unknown> = {
      model: this.preset ? `@preset/${this.preset}` : this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.maxTokens ?? 512,
    };
    if (!this.preset) {
      // Only set temperature when not using a preset — preset owns it.
      body.temperature = opts.temperature ?? 0.3;
    }
    if (opts.jsonMode !== false) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openrouter ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
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
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }
}
