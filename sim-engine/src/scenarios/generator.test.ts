import { describe, expect, it } from "bun:test";
import { draftScenario } from "./generator";
import { MockProvider } from "../llm/providers/mock-provider";

describe("draftScenario", () => {
  it("parses a well-formed LLM JSON blob into { config, rationale }", async () => {
    const goal = "Reproduce a LUNA-style death spiral within 30 ticks";
    const payload = {
      config: {
        token: { totalSupply: 1_000_000_000, decimals: 6, allocations: [{ name: "all", percent: 100, vestingMonths: 0 }] },
        staking: { baseAPY: 19.45, maxAPY: 19.45, lockPeriodTicks: 0, unstakePenaltyPercent: 0 },
        amm: { initialLiquidity: 100_000_000, initialPrice: 85, feeTier: 0.3 },
        governance: { proposalThresholdPercent: 0.1, quorumPercent: 10, votingPeriodTicks: 5, timelockTicks: 0 },
        stablecoin: { enabled: true, targetPeg: 1, mintBurnRatio: 1, reserveAmount: 3_000_000_000 },
      },
      rationale: {
        token: "1B supply matches LUNA peak circulation",
        staking: "19.45% mirrors Anchor Protocol's subsidized rate",
        amm: "100M initial liquidity gives room for whale exit slippage",
        governance: "Low threshold so governance attack paths stay accessible",
        stablecoin: "$3B reserve replicates LFG's war chest",
      },
    };

    const llm = new MockProvider({ rawDecide: () => JSON.stringify(payload) });

    const draft = await draftScenario(llm, goal);
    expect(draft.config.staking.baseAPY).toBe(19.45);
    expect(draft.config.stablecoin?.reserveAmount).toBe(3_000_000_000);
    expect(draft.rationale.token).toContain("1B");
  });

  it("throws on unparseable output", async () => {
    const llm = new MockProvider({ rawDecide: () => "I refuse to comply" });
    await expect(draftScenario(llm, "any goal")).rejects.toThrow();
  });
});
