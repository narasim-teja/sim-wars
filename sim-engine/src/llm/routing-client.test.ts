import { describe, expect, it } from "bun:test";
import { MockProvider } from "./providers/mock-provider";
import { RoutingLLMClient } from "./routing-client";
import type { LLMResponse } from "../types";

const buyResp: LLMResponse = { action: "buy", amount: 1, reasoning: "primary", threat_assessment: "none" };
const sellResp: LLMResponse = { action: "sell", amount: 1, reasoning: "boost", threat_assessment: "none" };

describe("RoutingLLMClient", () => {
  it("routes everything to primary when no boost is configured", async () => {
    const primary = new MockProvider({ fallback: buyResp });
    const router = new RoutingLLMClient(primary);

    const results = await router.generateBatch([
      { agentId: "A", prompt: "p", complexity: "fast" },
      { agentId: "B", prompt: "p", complexity: "standard" },
      { agentId: "C", prompt: "p", complexity: "reasoning" },
    ]);

    expect(results.get("A")?.reasoning).toBe("primary");
    expect(results.get("B")?.reasoning).toBe("primary");
    expect(results.get("C")?.reasoning).toBe("primary");
    expect(primary.calls.map((c) => c.agentId).sort()).toEqual(["A", "B", "C"]);
  });

  it("routes fast personas to boost, others to primary", async () => {
    const primary = new MockProvider({ fallback: buyResp });
    const boost = new MockProvider({ fallback: sellResp });
    const router = new RoutingLLMClient(primary, boost);

    const results = await router.generateBatch([
      { agentId: "DEGEN_01", prompt: "p", complexity: "fast" },
      { agentId: "PANIC_01", prompt: "p", complexity: "fast" },
      { agentId: "WHALE_01", prompt: "p", complexity: "reasoning" },
      { agentId: "HOLDER_01", prompt: "p", complexity: "standard" },
    ]);

    expect(results.get("DEGEN_01")?.reasoning).toBe("boost");
    expect(results.get("PANIC_01")?.reasoning).toBe("boost");
    expect(results.get("WHALE_01")?.reasoning).toBe("primary");
    expect(results.get("HOLDER_01")?.reasoning).toBe("primary");

    expect(primary.calls.map((c) => c.agentId).sort()).toEqual(["HOLDER_01", "WHALE_01"]);
    expect(boost.calls.map((c) => c.agentId).sort()).toEqual(["DEGEN_01", "PANIC_01"]);
  });

  it("treats missing complexity as standard (→ primary)", async () => {
    const primary = new MockProvider({ fallback: buyResp });
    const boost = new MockProvider({ fallback: sellResp });
    const router = new RoutingLLMClient(primary, boost);

    const results = await router.generateBatch([{ agentId: "X", prompt: "p" }]);
    expect(results.get("X")?.reasoning).toBe("primary");
    expect(boost.calls).toHaveLength(0);
  });
});
