/**
 * Build the user-message we send to the OpenRouter preset.
 *
 * The preset on OpenRouter sets model + system prompt + temperature. This
 * message is fully self-contained though, so the preset's system prompt
 * could even be empty and extraction would still work — defensive against
 * the user swapping models or rewriting the preset.
 */
export function buildExtractionUserMessage(args: {
  sourceLabel: string;
  sourceText: string;
}): string {
  const { sourceLabel, sourceText } = args;
  return `You are extracting DeFi tokenomics parameters from a whitepaper / docs to seed a multi-agent stress-test simulation.

Return ONLY a JSON object matching this shape (every field is OPTIONAL — only include fields you can ground in the source; never invent numbers):

{
  "config": {
    "token": {
      "totalSupply": <number, total minted supply (not circulating)>,
      "decimals": <int, default 6 if unstated>,
      "allocations": [
        { "name": "<string>", "percent": <0-100>, "vestingMonths": <int, 0 if unlocked> }
      ]
    },
    "staking": {
      "baseAPY": <percent, e.g. 19.45 for ~19.45% APY>,
      "maxAPY": <percent, top of range if a band is given; else same as baseAPY>,
      "lockPeriodTicks": <int — convert from days/weeks: 1 tick ~= 1 day; 0 if no lock>,
      "unstakePenaltyPercent": <percent>
    },
    "amm": {
      "initialLiquidity": <token-side liquidity at TGE>,
      "initialPrice": <price in USD at launch>,
      "feeTier": <percent, e.g. 0.3>
    },
    "governance": {
      "proposalThresholdPercent": <percent of supply needed to propose>,
      "quorumPercent": <percent of supply needed for quorum>,
      "votingPeriodTicks": <int — 1 tick ~= 1 day>,
      "timelockTicks": <int — 1 tick ~= 1 day>
    },
    "stablecoin": {
      "enabled": <true ONLY if the protocol has an algorithmic / collateralized stablecoin component>,
      "targetPeg": <number, usually 1 for USD>,
      "mintBurnRatio": <number, e.g. 1 means 1 USD of LUNA burned per 1 UST minted>,
      "reserveAmount": <number, USD value of backing reserve at TGE>
    }
  },
  "protocolName": "<string, e.g. 'Terra LUNA / UST'>",
  "protocolKind": "<one of: stablecoin_algo | liquid_staking | lending | amm_dex | governance_token | veToken | memecoin | other>",
  "confidence": <0-1, your overall confidence the extraction is faithful>,
  "notes": "<one short sentence flagging anything ambiguous, missing, or surprising>"
}

RULES:
- Output ONLY the JSON object. No prose, no markdown fences.
- OMIT any field you cannot ground in the source. Do not write nulls. Do not write "unknown".
- Convert time units to ticks where 1 tick ≈ 1 day (so "7 day lock" → 7, "2 weeks" → 14).
- Convert percentages to plain numbers (so "19.45%" → 19.45, not 0.1945).
- If allocations are listed but don't sum to 100, return them verbatim — do not normalize.
- "stablecoin.enabled" should be true ONLY for protocols that mint/burn a peg-target asset (Terra UST, Frax, etc.). Lending stables on top of collateral don't count.
- If the source is not a tokenomics document at all (e.g. a generic README, a code file, a research paper unrelated to a token), return: {"config":{},"notes":"source does not contain tokenomics","confidence":0}.

SOURCE (${sourceLabel}):
<<<
${sourceText}
>>>`;
}
