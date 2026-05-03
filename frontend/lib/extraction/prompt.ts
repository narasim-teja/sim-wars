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
    "metadata": {
      "protocolName": "<string, protocol/project name>",
      "tokenSymbol": "<string, base token under test, e.g. LUNA, CRV, JTO>",
      "quoteSymbol": "<string, quote/reserve token for the sim, usually USDC or USD>",
      "protocolKind": "<one of: stablecoin_algo | liquid_staking | lending | amm_dex | governance_token | veToken | memecoin | other>"
    },
    "token": {
      "totalSupply": <number, total minted supply (not circulating)>,
      "decimals": <int, default 6 if unstated>,
      "allocations": [
        {
          "name": "<string>",
          "percent": <0-100>,
          "vestingMonths": <int, TOTAL months from TGE until fully unlocked; 0 if unlocked at TGE>,
          "cliffMonths": <int, months before ANY tokens unlock; 0 if no cliff. MUST be ≤ vestingMonths>
        }
      ]
    },
    "staking": {
      "baseAPY": <percent, e.g. 19.45 for ~19.45% APY>,
      "maxAPY": <percent, top of range if a band is given; else same as baseAPY>,
      "lockPeriodTicks": <int — convert from days/weeks: 1 tick ~= 1 day; 0 if no lock>,
      "unstakePenaltyPercent": <percent — early-exit slash, often 0>,
      "unstakeCooldownTicks": <int — cooldown between request_unstake and complete_unstake. Convert from time: '7-day cooldown' → 7. 0 if instant>,
      "rewardEmissionRate": <fraction of total_staked emitted per tick into the reward vault. Map APY/emissions schedule: 'X% annual emissions' → X/100/365. 0 if rewards are funded only at TGE>
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
      "reserveAmount": <number, USD value of backing reserve at TGE>,
      "riskModel": {
        "borrowerRevenueRatio": <0-1, fraction of paid yield covered by real protocol/borrower revenue; Terra-like subsidy ≈ 0.15>,
        "redemptionThreshold": <peg price where redemptions accelerate; default 0.98 for USD pegs>,
        "maxRedemptionPercentPerTick": <0-1, max stable supply redeemed per tick; default 0.2>,
        "redemptionRateMultiplier": <number, multiplier from peg deviation to redeemed supply; default 0.5>,
        "sellPressureCoefficient": <number, sell/unstake pressure cap; default 0.4>,
        "reservePressureCoefficient": <number, reserve-depletion pressure cap; default 0.3>,
        "momentumPressureCoefficient": <number, price-momentum pressure cap; default 0.3>
      }
    },
    "veToken": {
      "enabled": <true ONLY if the protocol uses vote-escrow / time-weighted staking. Curve veCRV, Balancer veBAL, Frax veFXS all qualify. Generic time-locked staking with no governance weight does NOT qualify — that goes in 'staking.lockPeriodTicks'>,
      "maxLockMonths": <int, max lock duration. Curve = 48, many forks 12 or 24>,
      "voteWeightCurve": "<one of: linear-decay (weight scales with remaining lock — Curve default) | constant (fixed boost regardless of remaining time)>",
      "boostMultiplier": <number, max boost at full lock. 2.5 is the Curve canonical max>
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
- Also copy protocolName/protocolKind/tokenSymbol/quoteSymbol into config.metadata when known; top-level protocolName/protocolKind are kept for UI metadata.
- If allocations are listed but don't sum to 100, return them verbatim — do not normalize.
- "stablecoin.enabled" should be true ONLY for protocols that mint/burn a peg-target asset (Terra UST, Frax, etc.). Lending stables on top of collateral don't count.
- If the source is not a tokenomics document at all (e.g. a generic README, a code file, a research paper unrelated to a token), return: {"config":{},"notes":"source does not contain tokenomics","confidence":0}.

VESTING — extract carefully. Common patterns and how to encode them:
- "fully liquid at TGE" / "no vesting" / "circulating at launch"     → vestingMonths: 0,  cliffMonths: 0
- "linear over 24 months, no cliff"                                  → vestingMonths: 24, cliffMonths: 0
- "12-month cliff, then linear over 36 months"                       → vestingMonths: 48, cliffMonths: 12   (TOTAL = cliff + linear duration)
- "1-year cliff, 3-year linear unlock thereafter"                    → vestingMonths: 48, cliffMonths: 12
- "100% unlocked after 6 months" (lump-sum cliff, no linear)         → vestingMonths: 6,  cliffMonths: 6
- "25% at TGE, then linear over 18 months for the rest"              → split into TWO allocation entries: one with 25% and vestingMonths: 0, one with 75% (renamed e.g. "Team (vested)") and vestingMonths: 18, cliffMonths: 0
- If a cliff is mentioned without a linear schedule, assume the cliff IS the full unlock (vestingMonths = cliffMonths).
- If the source is silent on vesting for an allocation, default to vestingMonths: 0.

SOURCE (${sourceLabel}):
<<<
${sourceText}
>>>`;
}
