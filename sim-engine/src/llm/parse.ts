import type { LLMResponse, ActionType } from "../types";

const VALID_ACTIONS: ActionType[] = [
  "buy", "sell", "stake", "unstake",
  "vote_yes", "vote_no", "propose", "hold",
  "add_liquidity", "remove_liquidity",
  "mint_stablecoin", "burn_stablecoin",
];

export const DEFAULT_HOLD: LLMResponse = {
  action: "hold",
  amount: null,
  reasoning: "default_hold",
  threat_assessment: "none",
};

export function parseLLMResponse(raw: string): LLMResponse {
  try {
    return validateResponse(JSON.parse(raw));
  } catch {
    /* fall through */
  }

  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return validateResponse(JSON.parse(codeBlockMatch[1]!.trim()));
    } catch {
      /* fall through */
    }
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return validateResponse(JSON.parse(jsonMatch[0]));
    } catch {
      /* fall through */
    }
  }

  return { ...DEFAULT_HOLD, reasoning: "parse_failure" };
}

function validateResponse(parsed: unknown): LLMResponse {
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_HOLD, reasoning: "invalid_payload" };
  }
  const obj = parsed as Record<string, unknown>;
  const action = obj.action as string | undefined;

  if (!action || !VALID_ACTIONS.includes(action as ActionType)) {
    return { ...DEFAULT_HOLD, reasoning: `invalid_action: ${action}` };
  }

  return {
    action: action as ActionType,
    amount: typeof obj.amount === "number" ? obj.amount : null,
    reasoning: String(obj.reasoning ?? "no_reasoning"),
    threat_assessment: String(obj.threat_assessment ?? "none"),
  };
}
