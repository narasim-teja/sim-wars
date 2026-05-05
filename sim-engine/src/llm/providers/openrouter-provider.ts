import type { LLMResponse } from "../../types";
import type { LLMClient, LLMBatchItem, LLMGenerateOptions, LLMUsage, PromptZone } from "../types";
import { ZERO_USAGE } from "../types";
import { parseLLMResponse, DEFAULT_HOLD } from "../parse";

/**
 * OpenAI-compatible message content block. The `cache_control` field is
 * the OpenRouter / Anthropic / Qwen explicit cache marker — provider-side
 * caching layers see it and split the prompt at that boundary.
 */
type ContentBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type Message = { role: "system" | "user"; content: string | ContentBlock[] };

function parseCacheMode(raw: string | undefined): CacheMode | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "flat" || lower === "explicit") return lower;
  throw new Error(`SIM_LLM_CACHE_MODE: unknown value "${raw}" — expected "flat" or "explicit"`);
}

interface OpenRouterUsageBlock {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  cost?: number;
}

/**
 * Per-provider strategy for prompt caching.
 *
 * - `flat`: send the whole prompt as a single user-message string. Compatible
 *   with every OpenRouter-hosted model. Lets implicit caching fire on
 *   providers that support it (OpenAI, DeepSeek, Groq, Mistral 8B, etc.) by
 *   keeping the message-array hash stable across requests.
 *
 * - `explicit`: split zones into a system message of `cache_control: ephemeral`
 *   content blocks + a user message of dynamic content. Required for Anthropic,
 *   Qwen-plus / qwen3-coder-flash family, Gemini 2.5 explicit caching. Will
 *   *break* implicit caching on Mistral 8B (verified in cache-spike — content
 *   arrays disable implicit cache there).
 *
 * Default is `flat` because it's the lowest-risk choice across the OpenRouter
 * model catalog. Switch to `explicit` per-preset/per-model when the underlying
 * model is on the explicit-cache list.
 */
export type CacheMode = "flat" | "explicit";

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
  /**
   * Cache strategy for zoned prompts. Defaults to `flat`. Override via
   * the `SIM_LLM_CACHE_MODE` env var (`flat` | `explicit`) or pass directly
   * when constructing the provider in code. `flat` is broadly compatible;
   * `explicit` only when the underlying model is in the cache_control set.
   */
  cacheMode?: CacheMode;
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
  private cacheMode: CacheMode;
  private accumulatedUsage: LLMUsage = { ...ZERO_USAGE };

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.preset = opts.preset;
    const resolvedModel = opts.model ?? process.env.LLM_MODEL;
    if (!this.preset && !resolvedModel) {
      throw new Error(
        "OpenRouterProvider: no model configured. Set OPENROUTER_AGENT_PRESET (preferred) or LLM_MODEL — there is no fallback default to keep cost/quality predictable.",
      );
    }
    this.model = resolvedModel ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";
    this.referer = opts.referer ?? process.env.OPENROUTER_REFERER;
    this.title = opts.title ?? process.env.OPENROUTER_TITLE ?? "sim-wars";
    this.cacheMode = opts.cacheMode ?? parseCacheMode(process.env.SIM_LLM_CACHE_MODE) ?? "flat";
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
    return this.requestRaw([{ role: "user", content: prompt }], opts);
  }

  /**
   * POST to /chat/completions with pre-built messages. All shape decisions
   * (cache_control, content arrays vs strings) happen in the caller — this
   * method just sends bytes and accumulates usage.
   */
  private async requestRaw(messages: Message[], opts: LLMGenerateOptions): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    const body: Record<string, unknown> = {
      model: this.preset ? `@preset/${this.preset}` : this.model,
      messages,
      max_tokens: opts.maxTokens ?? 512,
      // Ask OpenRouter to echo the usage block so we can track per-request
      // cost + cache hit rate. Cheap, just a flag.
      usage: { include: true },
    };
    if (!this.preset) {
      // Preset owns temperature; setting it here would override the dashboard.
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
      usage?: OpenRouterUsageBlock;
    };
    if (data.usage) this.recordUsage(data.usage);
    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Build OpenAI-compatible messages from prompt zones with a single
   * cache_control breakpoint at the end of the last cacheable zone.
   *
   * Layout:
   *   system: [frame, archetype + cache_control] → one cache lane shared by
   *           every agent of the same persona (sticky-routed by OpenRouter
   *           on system-msg-hash + first-user-msg-hash).
   *   user:   dynamic (per-tick state) → never cached.
   *
   * Why this shape: OpenRouter's documented rule is "only the last cache
   * breakpoint is used for read." Putting it at the boundary between the
   * stable and the per-tick content gives the maximum read window without
   * risking dynamic content getting hashed into the cached prefix.
   */
  private buildZonedMessages(zones: PromptZone[]): Message[] {
    const stableZones = zones.filter((z) => z.id !== "dynamic");
    const dynamicZones = zones.filter((z) => z.id === "dynamic");

    // Edge case: no stable zones (shouldn't happen for agent prompts, but
    // be defensive). Fall back to a single user message.
    if (stableZones.length === 0) {
      return [{ role: "user", content: dynamicZones.map((z) => z.text).join("\n\n") }];
    }

    const systemBlocks: ContentBlock[] = stableZones.map((z, i) => ({
      type: "text",
      text: z.text,
      ...(i === stableZones.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const userText = dynamicZones.map((z) => z.text).join("\n\n");
    const messages: Message[] = [{ role: "system", content: systemBlocks }];
    if (userText.length > 0) {
      messages.push({ role: "user", content: userText });
    }
    return messages;
  }

  private recordUsage(u: OpenRouterUsageBlock): void {
    this.accumulatedUsage.calls += 1;
    this.accumulatedUsage.promptTokens += u.prompt_tokens ?? 0;
    this.accumulatedUsage.completionTokens += u.completion_tokens ?? 0;
    this.accumulatedUsage.cachedTokens += u.prompt_tokens_details?.cached_tokens ?? 0;
    this.accumulatedUsage.cacheWriteTokens += u.prompt_tokens_details?.cache_write_tokens ?? 0;
    this.accumulatedUsage.costUsd += u.cost ?? 0;
  }

  drainUsage(): LLMUsage {
    const drained = this.accumulatedUsage;
    this.accumulatedUsage = { ...ZERO_USAGE };
    return drained;
  }

  async generateBatch(items: LLMBatchItem[]): Promise<Map<string, LLMResponse>> {
    const results = new Map<string, LLMResponse>();
    await Promise.all(
      items.map(async (item) => {
        try {
          // Pick prompt shape based on cache mode:
          //   explicit → split zones into system content blocks + cache_control
          //              breakpoint, dynamic content as user message.
          //   flat (default) → single user message, lets implicit caching fire
          //                    on providers that support it (OpenAI, DeepSeek,
          //                    Mistral 8B, etc.) and stays compatible with
          //                    everything else.
          const messages = (this.cacheMode === "explicit" && item.zones && item.zones.length > 0)
            ? this.buildZonedMessages(item.zones)
            : [{ role: "user" as const, content: item.prompt }];
          const raw = await this.requestRaw(messages, {});
          results.set(item.agentId, parseLLMResponse(raw));
        } catch (err) {
          console.error(`  [${this.name}] error for ${item.agentId}:`, (err as Error).message);
          results.set(item.agentId, { ...DEFAULT_HOLD, reasoning: `llm_error: ${(err as Error).message}` });
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
