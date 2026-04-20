import { describe, expect, it } from "bun:test";
import { parseLLMResponse, DEFAULT_HOLD } from "./parse";

describe("parseLLMResponse", () => {
  it("parses a direct JSON response", () => {
    const raw = '{"action":"sell","amount":100,"reasoning":"r","threat_assessment":"t"}';
    const parsed = parseLLMResponse(raw);
    expect(parsed.action).toBe("sell");
    expect(parsed.amount).toBe(100);
  });

  it("extracts JSON from markdown code fences", () => {
    const raw = '```json\n{"action":"buy","amount":5,"reasoning":"r","threat_assessment":"t"}\n```';
    const parsed = parseLLMResponse(raw);
    expect(parsed.action).toBe("buy");
    expect(parsed.amount).toBe(5);
  });

  it("extracts the first JSON object from noisy text", () => {
    const raw = 'Thinking... here is my choice {"action":"stake","amount":null,"reasoning":"r","threat_assessment":"t"} done.';
    const parsed = parseLLMResponse(raw);
    expect(parsed.action).toBe("stake");
    expect(parsed.amount).toBeNull();
  });

  it("falls back to hold on unparseable text", () => {
    const parsed = parseLLMResponse("I refuse to comply");
    expect(parsed.action).toBe(DEFAULT_HOLD.action);
    expect(parsed.reasoning).toBe("parse_failure");
  });

  it("rejects invalid actions", () => {
    const raw = '{"action":"launch_missiles","amount":9999,"reasoning":"r","threat_assessment":"t"}';
    const parsed = parseLLMResponse(raw);
    expect(parsed.action).toBe("hold");
    expect(parsed.reasoning).toContain("invalid_action");
  });
});
