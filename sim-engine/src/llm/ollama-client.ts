import type { LLMResponse, ActionType } from "../types";

const VALID_ACTIONS: ActionType[] = [
  "buy", "sell", "stake", "unstake",
  "vote_yes", "vote_no", "propose", "hold",
  "add_liquidity", "remove_liquidity",
  "mint_stablecoin", "burn_stablecoin",
];

const DEFAULT_HOLD: LLMResponse = {
  action: "hold",
  amount: null,
  reasoning: "default_hold",
  threat_assessment: "none",
};

export class OllamaClient {
  private model: string;
  private baseUrl: string;

  constructor(
    model: string = "qwen3:8b",
    baseUrl: string = "http://localhost:11434"
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generate(prompt: string): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.3,
          num_predict: 512,
          top_p: 0.9,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      response: string;
      done: boolean;
      total_duration?: number;
      eval_count?: number;
    };

    return this.parseResponse(data.response);
  }

  /**
   * Generate decisions for multiple agents in parallel.
   */
  async generateBatch(prompts: { agentId: string; prompt: string }[]): Promise<Map<string, LLMResponse>> {
    const results = new Map<string, LLMResponse>();

    const promises = prompts.map(async ({ agentId, prompt }) => {
      try {
        const response = await this.generate(prompt);
        results.set(agentId, response);
      } catch (error) {
        console.error(`  LLM error for ${agentId}:`, error);
        results.set(agentId, { ...DEFAULT_HOLD, reasoning: `llm_error: ${error}` });
      }
    });

    await Promise.all(promises);
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

  private parseResponse(raw: string): LLMResponse {
    // Strategy 1: Direct JSON parse
    try {
      const parsed = JSON.parse(raw);
      return this.validateResponse(parsed);
    } catch {
      // continue to fallback
    }

    // Strategy 2: Extract JSON from markdown code blocks
    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        return this.validateResponse(parsed);
      } catch {
        // continue
      }
    }

    // Strategy 3: Find first JSON object in response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return this.validateResponse(parsed);
      } catch {
        // continue
      }
    }

    // Strategy 4: Give up, return hold
    console.warn("  Failed to parse LLM response, defaulting to hold");
    return { ...DEFAULT_HOLD, reasoning: "parse_failure" };
  }

  private validateResponse(parsed: Record<string, unknown>): LLMResponse {
    const action = parsed.action as string;

    if (!action || !VALID_ACTIONS.includes(action as ActionType)) {
      return {
        ...DEFAULT_HOLD,
        reasoning: `invalid_action: ${action}`,
      };
    }

    return {
      action: action as ActionType,
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      reasoning: String(parsed.reasoning || "no_reasoning"),
      threat_assessment: String(parsed.threat_assessment || "none"),
    };
  }
}
