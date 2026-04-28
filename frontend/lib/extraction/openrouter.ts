/**
 * Tiny OpenRouter client for the extraction pipeline.
 *
 * Calls a *preset* — model, system prompt, temperature, fallbacks all live on
 * the OpenRouter dashboard. The app sends just the user message + JSON-mode
 * flag, so swapping models on the dashboard takes effect without a redeploy.
 *
 * NOT used for sim-engine agent calls. The agent path uses sim-engine's own
 * OpenRouter provider.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface ExtractionCallResult {
  /** Raw JSON string from the model — already parsed downstream. */
  json: string;
  /** Model id the preset routed to (for telemetry / debugging). */
  model: string;
  /** Tokens consumed, for cost-watching. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export async function callExtractionPreset(args: {
  apiKey: string;
  preset: string;
  userMessage: string;
  /** AbortSignal so the route can cancel on client disconnect. */
  signal?: AbortSignal;
}): Promise<ExtractionCallResult> {
  const { apiKey, preset, userMessage, signal } = args;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "sim-wars-extraction",
    },
    signal,
    body: JSON.stringify({
      model: `@preset/${preset}`,
      messages: [{ role: "user", content: userMessage }],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openrouter ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("openrouter returned empty content");

  return {
    json: stripFences(content),
    model: data.model ?? `@preset/${preset}`,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined,
  };
}

/**
 * Some models (especially when JSON mode isn't fully respected) wrap output
 * in ```json fences. Strip them defensively so JSON.parse always sees clean
 * input.
 */
function stripFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}
