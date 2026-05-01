# Autonomy + Accuracy Plan
### Closing the gap between "we extract X" and "we deploy X correctly"

> Backend / sim-engine only. No UI changes in this plan. Drafted 2026-05-01.

## Locked-in decisions (2026-05-01)

User confirmed before kickoff:

1. **Curve depth → engine-side approximation.** The veToken behavior (lock_until_tick, time-weighted vote weight) lives in the simulation engine, not the on-chain programs. Generalized: the same code path serves any extracted protocol — for non-veToken tokens it's a no-op.
2. **Roster expansion → deterministic archetype scaling** (Option A in the explanation). Recommendation accepted with the caveat that an explicit `agents: AgentPersona[]` override is still allowed for power users.
3. **Reward vault inflation → wire it now** alongside Phase 2 staking honesty. One-shot seeding doesn't survive 100-agent / 50-tick runs.
4. **Agent count cap + model routing:**
   - Cap defined in a constants file (`sim-engine/src/constants.ts`), default `MAX_AGENTS = 100`.
   - **Sim agents → cheap open-source model** via OpenRouter preset (`OPENROUTER_AGENT_PRESET`, e.g. routed to `qwen/qwen3-8b` or similar — cheapest hosted model on the dashboard).
   - **Extraction → Gemini 3 Flash** via the existing `OPENROUTER_EXTRACTION_PRESET=whitepaper-extractor` preset.
   - **Report generation → Gemini 3 Flash** via new `OPENROUTER_REPORT_PRESET`.
5. **Vesting beneficiary → cheap path.** Deployer plays "team multisig" — single vesting PDA per vested allocation. Per-agent vesting is out.

## Baseline (Phase 0 captured)

- `anchor build --ignore-keys`: clean (deprecation warnings only, `anchor-debug` cfg × 9 in governance, similar in staking).
- sim-engine: **40/40 tests** pass across 12 files (~1.2s).
- program-tests (LiteSVM): **19/19 pass** (4 amm + 6 governance + 6 staking + 3 token-mint).
- frontend `tsc --noEmit`: clean.
- Toolchain: bun 1.3.11, node 24.14.1, cargo 1.94.1, anchor-cli 1.0.0.

## Final state (after Phases 0–5)

- `anchor build --ignore-keys`: clean.
- sim-engine: **58/58 tests** (was 40 → +18: 7 veToken, 9 roster, 2 agentCount integration).
- program-tests: **23/23 tests** (was 19 → +4: vesting cliff math, penalty routing, zero-penalty payout, max<base reject).
- frontend + sim-engine `tsc --noEmit`: clean.

### What changed, by file

**Programs (Rust):**
- [programs/staking/src/lib.rs](../programs/staking/src/lib.rs) — `initialize_pool` now takes `max_apy_bps` + `unstake_penalty_bps`. `complete_unstake` slashes the configured penalty to the reward vault. Two new error codes: `MaxBelowBase`, `PenaltyTooHigh`.

**Sim-engine TypeScript:**
- [src/types.ts](../sim-engine/src/types.ts) — `Allocation.cliffMonths`, `staking.unstakeCooldownTicks` + `rewardEmissionRate`, `veToken` block.
- [src/constants.ts](../sim-engine/src/constants.ts) — new file. `MAX_AGENTS=100`, `DEFAULT_AGENT_COUNT=20`, perturbation bounds.
- [src/agents/roster.ts](../sim-engine/src/agents/roster.ts) — new file. Deterministic archetype expander (3 presets: luna / crv / balanced).
- [src/agents/roster.test.ts](../sim-engine/src/agents/roster.test.ts) — new file. 9 tests, locks in mix ratios + reproducibility.
- [src/agents/orchestrator.ts](../sim-engine/src/agents/orchestrator.ts) — `defaultLockTicks()` helper auto-applies max-lock when veToken is enabled.
- [src/tick/state-manager.ts](../sim-engine/src/tick/state-manager.ts) — `lockUntilTick` map, `stake(agentId, amount, lockTicks?)`, `unstake` refuses while locked, `getVoteWeight` returns time-weighted weight, `getTotalStaked`, `getConfig`.
- [src/tick/state-manager.test.ts](../sim-engine/src/tick/state-manager.test.ts) — new file. 7 tests for veToken behavior.
- [src/llm/factory.ts](../sim-engine/src/llm/factory.ts) — `OPENROUTER_AGENT_PRESET` + `OPENROUTER_BOOST_PRESET` env hooks. New `buildReportLLMClient()` reads `OPENROUTER_REPORT_PRESET`.
- [src/llm/providers/openrouter-provider.ts](../sim-engine/src/llm/providers/openrouter-provider.ts) — `preset` option; when set, sends `model: "@preset/<slug>"` instead of `LLM_MODEL`.
- [src/chain/sdk.ts](../sim-engine/src/chain/sdk.ts) — `deriveVesting()` PDA helper, `VestingEntry`, `Deployment.vesting`, `StakingDeployment.{maxApyBps, unstakePenaltyBps, rewardEmissionRate}`.
- [src/chain/action-executor.ts](../sim-engine/src/chain/action-executor.ts) — `claimAllVested(currentTick)`, `fundRewardVault(amount)`, `hasVesting()`, `getVestingEntries()`.
- [src/worker/main.ts](../sim-engine/src/worker/main.ts) — report path uses `buildReportLLMClient()`.
- [src/worker/simulation.ts](../sim-engine/src/worker/simulation.ts) — per-tick `claimAllVested` + `fundRewardVault` calls.
- [src/api/server.ts](../sim-engine/src/api/server.ts) — `agentCount` + `rosterPreset` body fields, expander fallback, MAX_AGENTS guard.
- [src/api/server.integration.test.ts](../sim-engine/src/api/server.integration.test.ts) — 2 new tests: roster expansion + MAX_AGENTS rejection.
- [scripts/deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts) — cliff translation (`vesting_ticks = (total - cliff) × 30`), per-allocation beneficiary keypairs, real `create_vesting` calls, `max_apy_bps` + `unstake_penalty_bps` + emission-rate flow-through, liquid-bucket pool seed.
- [scripts/e2e-extract-and-sim.ts](../sim-engine/scripts/e2e-extract-and-sim.ts) — new file. Real-network driver: PDF → extract → POST /api/sim → poll → fetch report.

**Frontend TypeScript:**
- [lib/extraction/schema.ts](../frontend/lib/extraction/schema.ts) — `cliffMonths` per allocation, `unstakeCooldownTicks` + `rewardEmissionRate`, `veToken` block. Post-parse clamp (cliff ≤ vesting).
- [lib/extraction/prompt.ts](../frontend/lib/extraction/prompt.ts) — cliff guidance with 6 worked examples, veToken extraction rules, emission-rate hints.

**Program tests (Rust):**
- [program-tests/tests/token_mint.rs](../program-tests/tests/token_mint.rs) — `vesting_cliff_blocks_early_claim_then_unlocks_linearly` end-to-end test.
- [program-tests/tests/staking.rs](../program-tests/tests/staking.rs) — 3 new tests for unstake penalty + max-vs-base validation.

**Env / docs:**
- [.env.example](../.env.example) — three new OpenRouter preset slots documented (`AGENT`, `BOOST`, `REPORT`) + recommended cost-efficient setup.

### Phase 5 — what shipped vs. what's runtime

- ✅ Hermetic integration test: `agentCount` + roster expansion + worker + WS, all green.
- ⚠️ Real-network E2E (Curve PDF → real OpenRouter → real chain): runner script ready at [scripts/e2e-extract-and-sim.ts](../sim-engine/scripts/e2e-extract-and-sim.ts). You provide: a PDF, a running frontend on :3000, a sim-engine API on :8787, OPENROUTER_API_KEY + the four configured presets. With `--on-chain`, also a running validator. The script emits `extraction.json`, `report.json`, `summary.json` into `--out`.

---

## Why this doc

The current end-to-end story is:

```
whitepaper.pdf  →  extract (1 LLM call)  →  SimulationConfig JSON
                                              │
                                              ▼
                              POST /api/sim { config, agents, onChain: true }
                                              │
                                              ▼
                              deploy-from-config.ts  →  4 Anchor programs
                                              │
                                              ▼
                              SimWorker spawns agents (Ollama / OpenRouter raw model)
```

Every stage works in isolation. The compounded result has gaps:

| Stage | Gap (what we extract or claim) | What actually happens on-chain |
|---|---|---|
| Extraction | "team vests over 48 months with a 12-month cliff" | Cliff field doesn't exist in the schema. `cliff_ticks=0` is hardcoded in the deploy script. |
| Deploy | Vesting allocations get an `AllocationBucket` PDA per the program | `create_vesting` is **never called for any beneficiary** — every vested allocation is silently distributed via the ecosystem bucket, immediately unlocked. |
| Deploy | `staking.maxAPY` and `staking.unstakePenaltyPercent` exist in `SimulationConfig` | Both are dropped on the floor — the staking program only takes `base_apy_bps` + `cooldown_ticks` and the script hardcodes `cooldown=1`. |
| Deploy | `stablecoin.{enabled, mintBurnRatio, reserveAmount}` exist | `mint_from_burn` is **never invoked** from the deploy script or the action executor. The reserve drain is a `StateManager` accounting trick. |
| Agent LLM | Frontend uses `OPENROUTER_EXTRACTION_PRESET=whitepaper-extractor` ✅ | Sim-engine `OpenRouterProvider` calls `LLM_MODEL` directly — no preset, no parity with the extraction call. |
| Agent count | "Run 50–100 agents" | The frontend ships **fixed JSON files** for 8, 20, and CRV. No `agentCount=N` path. |
| Curve | "we have a CRV scenario" | Hand-tuned personas with comments saying "agents *can't* unstake mid-sim" — but the staking program **has no lock-time concept**, voting power is just `stake.amount` (not time-weighted). |

This plan tackles those in order of "biggest accuracy lift per hour of work."

---

## Inventory: what exists and works today

Confirmed by reading code on 2026-05-01:

- 4 Anchor 1.0 programs build clean with `anchor build --ignore-keys` (warnings only).
- `token_mint`: full `create_vesting` + `claim_vested` instructions exist with cliff + linear unlock (program supports it; deploy never uses it).
- `staking`: lock period + cooldown + linear constant APY. No max APY, no penalty, no time-weighted voting.
- `governance`: stake-weighted voting, proposal threshold, quorum, voting period, timelock. Voting weight = `stake.amount` (no time component).
- `amm-dex`: constant product (`x*y=k`). No StableSwap, no DLMM bins, no concentrated liquidity.
- Frontend extraction calls `@preset/whitepaper-extractor` correctly via `OPENROUTER_EXTRACTION_PRESET`.
- Sim-engine `RoutingLLMClient` already splits primary / boost LLM by `complexity` field on personas (working).
- `POST /api/sim` accepts arbitrary `agents: AgentPersona[]` — engine itself is N-agent ready.
- `ChainExecutor` wires swap, stake, request_unstake, complete_unstake, claim_rewards, create_proposal, cast_vote on-chain. Vesting (`create_vesting`, `claim_vested`) and stablecoin mint/burn are NOT wired.

---

## Phase 0 — Baseline & build hardening (½ day)

**Goal:** confirm green baseline, then we know any new failures come from this plan, not pre-existing rot.

- [ ] Run `anchor build --ignore-keys` and capture the warning set as a baseline (today: `unexpected cfg condition value: anchor-debug` × 9 in governance, similar in staking).
- [ ] Run `bun test` in `sim-engine/` — capture pass count baseline (plan.md cites 36/36 sim-engine tests).
- [ ] Run `cargo test -p program-tests` — capture pass count (plan.md cites 19/19 LiteSVM tests).
- [ ] Optionally: silence the `anchor-debug` warnings via `[lints]` in each program's `Cargo.toml` so future build output stays scannable. **Cosmetic — skip if tight on time.**

**Deliverable:** a "before" snapshot in CI (or a comment in this doc) so we can diff after each phase.

---

## Phase 1 — Vesting wiring (the biggest accuracy gap) (1–2 days)

**Goal:** what the whitepaper says about vesting actually happens on-chain.

### 1.1 Schema + prompt

- Extend [extraction Allocation schema](../frontend/lib/extraction/schema.ts) with `cliffMonths: number (default 0)`.
- Extend [SimulationConfig.token.allocations](../sim-engine/src/types.ts) to match.
- Update [extraction prompt](../frontend/lib/extraction/prompt.ts) with explicit cliff instructions ("if the source says '12-month cliff, then 36-month linear', output `{ vestingMonths: 48, cliffMonths: 12 }`"). Add 2–3 worked examples to the prompt. Keep the OpenRouter preset slug fixed; only the user-message changes.
- Mirror the cliff field through to [scenarios JSON](../frontend/lib/scenarios/) and the [LUNA + CRV scenario configs](../sim-engine/scenarios/). Today they all encode `vestingMonths` only.

### 1.2 Deploy script

In [deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts):

- Today: `vestingTicks: a.vestingMonths === 0 ? 0 : a.vestingMonths * 30, cliffTicks: 0` — replace the hardcoded cliff with `Math.max(0, a.cliffMonths) * 30`.
- For each allocation with `vestingTicks > 0`, after `create_allocation`, call `create_vesting` with the deployer (or a designated beneficiary) as the beneficiary, then **stop** sending those tokens through the immediate `distributeAllocation` path. The on-chain vesting PDA + `claim_vested` is the only lawful unlock path.
- Decision rule for "who is the beneficiary":
  - Allocations with names containing "team", "founder", "investor", "advisor" → single deployer-owned vesting account (the deployer plays the role of "team multisig" for the sim).
  - All other vested allocations → also deployer-owned vesting (treasury). Per-agent vesting is overkill for the sim and would 20× the deploy cost.
- Liquid allocations (`vestingMonths === 0`) keep the current `distributeAllocation` immediate-mint path.
- Pool seed liquidity comes out of the largest **liquid** allocation (today the script picks "largest by percent_bps" — that may grab a vested bucket; switch to "largest with `vestingTicks == 0`").

### 1.3 Engine wiring

- Add a tick-driven `claim_vested` call in [worker/simulation.ts](../sim-engine/src/worker/simulation.ts) (or a new `vesting-controller.ts`) that, every N ticks, sweeps vesting accounts and triggers `claim_vested` if `current_tick >= cliff_ticks`. The newly minted tokens land in the deployer's ATA and become observable supply.
- Surface the unlocked supply in `SimulationState` (`circulatingSupply` already exists — make sure it's actually moving, not constant).

### 1.4 Verify

- New test: `program-tests` integration test that drives a 48-month-with-12-month-cliff allocation through 60 ticks and asserts (a) nothing claimable before tick 360 (12mo × 30), (b) linear claim after.
- New sim-engine test: `extract → deploy → run` round-trip that asserts vested supply only enters circulation per the cliff/linear curve.

---

## Phase 2 — Staking + governance round-trip honesty (1 day)

**Goal:** every field in `SimulationConfig.staking` and `SimulationConfig.governance` actually shapes the deployed program. No more silent drops.

### 2.1 Staking program — accept the missing parameters

- Add to `staking.initialize_pool`:
  - `max_apy_bps: u16` — store, do not yet act on it (Phase 5 wires dynamic APY).
  - `unstake_penalty_bps: u16` — store. In `complete_unstake`, transfer `(amount * (10_000 − penalty_bps)) / 10_000` to user; the slashed remainder stays in the stake vault as a permanent fee burn (or transfers to reward vault — pick one and document it).
- Add to `set_tick` no change. Already monotonic.
- Migration: existing `StakingPool` accounts will fail to deserialize after the struct grows. **For the hackathon scope, this is fine — we wipe runs/ between deploys.** Document that explicitly.

### 2.2 Deploy script

- Pass `max_apy_bps = round(maxAPY * 100)` and `unstake_penalty_bps = round(unstakePenaltyPercent * 100)`.
- Stop hardcoding `cooldownTicks = 1`. Either extract a `unstakeCooldownTicks` field (preferred) or derive it from `lockPeriodTicks / 5` (defensive default). Add a field — easier to extract.

### 2.3 Verify

- LiteSVM test: stake 1000, request_unstake 500, advance past cooldown, complete_unstake → assert user received `500 × (1 − penalty_bps/10000)` and the slashed amount lives where you said it would.
- Sim-engine smoke: a scenario with `unstakePenaltyPercent: 5` shows up in agent PnL deltas (panic-sellers eat the haircut visibly in the report).

---

## Phase 3 — Sim-engine OpenRouter preset + variable agent count (1 day)

**Goal:** sim-engine and extraction both use named OpenRouter presets (so model+system+temperature live on the dashboard); user can ask for any N agents up to ~100.

### 3.1 Sim-engine preset support

In [openrouter-provider.ts](../sim-engine/src/llm/providers/openrouter-provider.ts):

- New env vars (mirror the extraction pattern):
  - `OPENROUTER_AGENT_PRESET=agent-decisions` (primary)
  - `OPENROUTER_BOOST_PRESET=agent-decisions-fast` (boost)
- When the relevant preset env is set, `OpenRouterProvider` sends `model: "@preset/<preset>"` instead of `LLM_MODEL`. `LLM_MODEL` becomes a fallback only.
- Add `OPENROUTER_REPORT_PRESET=report-writer` for the report generator. The report path already uses `llm.generateRaw`; tag those calls with a different preset. (Either build a separate `LLMClient` instance for the report, or thread a `preset` opt through `generateRaw`.)
- Update [.env.example](../.env.example) and [frontend/.env.local.example](../frontend/.env.local.example) so both files document **all three** presets in one place.

### 3.2 Variable agent count

`POST /api/sim` body shape:

```ts
interface CreateSimBody {
  config: SimulationConfig;
  agents?: AgentPersona[];          // explicit roster (legacy path)
  agentCount?: number;              // NEW — alternative to agents[]
  rosterPreset?: "luna" | "crv" | "balanced";  // NEW — which archetype mix to scale
  tickConfig: TickConfig;
  onChain?: boolean;
}
```

If `agents` is omitted but `agentCount` is set:
- Build the roster deterministically by scaling the 13 archetypes in [personas.ts](../sim-engine/src/agents/personas.ts) with proportional cloning + parameter perturbation (small RNG seeded by `simId` so runs are reproducible). For example, `agentCount=50, rosterPreset="luna"` produces something like:
  - 4 whales (capital perturbation ±20%)
  - 8 yield farmers
  - 8 retail degens
  - 4 governance attackers
  - 4 sybil swarms
  - 4 MEV bots
  - 6 long-term holders
  - 4 arbitrageurs
  - 2 treasury, 2 LP, 1 analyst, 1 insider, 2 panic
- Cap at `MAX_AGENTS = 100` with a 400 error above that.
- Each cloned persona inherits the parent's `complexity` field, so boost-routing still works.

### 3.3 Verify

- Unit test the roster expander with `agentCount ∈ {8, 20, 50, 100}`: roster size matches, archetype mix matches the preset's ratios within ±1.
- Integration test against `LLM_PROVIDER=mock`: 100-agent sim runs to completion in under N seconds.
- Cost guardrail: log estimated OpenRouter spend per tick on `sim:start` (`agentCount × ticks × avg_tokens_per_call × $/Mtok`). Stretch goal — could land in Phase 6.

---

## Phase 4 — Curve / veCRV accuracy (1–2 days, scope-bounded)

**Goal:** when the extracted protocol is a veToken, the simulation reflects time-weighted voting. NOT a full on-chain veToken — a pragmatic engine-side approximation.

### 4.1 Schema additions

Add to extraction schema + prompt + types, gated by `protocolKind === "veToken"`:

```
veToken: {
  maxLockMonths: number       // e.g. 48 for Curve
  voteWeightCurve: "linear-decay" | "constant"
  boostMultiplier: number     // max boost for max-locked stakers
}
```

### 4.2 Engine-side veToken

- In [state-manager.ts](../sim-engine/src/tick/state-manager.ts), introduce a per-agent `lockedUntilTick: number` field tracked in memory.
- When a veToken protocol is detected, `stake` requires `lockMonths` ∈ `[1, maxLockMonths]`; the `StateManager` records `lockedUntilTick = currentTick + lockMonths*30`.
- `unstake` is a no-op (returns 0) when `currentTick < lockedUntilTick`.
- Voting weight in `castVote` becomes `stakedAmount × ((lockedUntilTick - currentTick) / (maxLockMonths*30))` for `linear-decay`. Plumbed into local proposal tally; chain-side governance still uses `stake.amount` (it has no concept of time — out of scope for v1).
- Surface time-weighted voting power per agent in `SimulationState` so the report can reason about it.

### 4.3 Action executor

- For veToken protocols, the chain-side stake call still happens (tokens really get locked in the staking vault). But the engine-side `lockedUntilTick` becomes the source of truth for "can this agent unstake?". When `currentTick < lockedUntilTick`, the engine refuses the action before it reaches the chain.

### 4.4 Verify

- Integration test: load Curve whitepaper PDF (drop into `sim-engine/.local/test-fixtures/curve.pdf`), run extraction with `LLM_PROVIDER=mock` plus a hard-coded fixture extraction outcome, assert `protocolKind=veToken` and `maxLockMonths=48`.
- End-to-end test: 30-tick CRV scenario produces NO death spiral, AND at least one whale agent attempts unstake before lock expiry and is correctly blocked.

### 4.5 Out of scope (Phase 5+)

Documented but not implemented in this round:

- On-chain veToken: extend the staking program with `lock_until_tick` per stake account + a CPI to governance for `cast_vote_with_weight` that reads time-weighted weight.
- StableSwap invariant in the AMM (Curve uses this; current AMM is constant-product and is meaningfully wrong for stable assets).
- Gauge / bribe markets (voting on emission redirects, off-chain bribe acceptance).

---

## Phase 5 — End-to-end Curve test on real whitepaper (½ day)

**Goal:** drop the actual Curve whitepaper, watch the whole pipeline produce a non-death-spiral run.

- Drop `curve-tokenomics.pdf` into `sim-engine/.local/test-fixtures/` (gitignored — large).
- New script `sim-engine/scripts/e2e-curve.ts`:
  1. Read the PDF, call extraction (real OpenRouter, real preset).
  2. Print the extracted `SimulationConfig` + `protocolKind` + `confidence`.
  3. POST to `/api/sim` with `agentCount=50, rosterPreset="crv", onChain=true`.
  4. Tail events until `sim:complete`.
  5. Fetch `/api/sim/:id/report` and assert: `deathSpiralDetected === false`, resilience grade ≥ B.
- Document the run in this doc as the "we did the thing" artifact (curl outputs, report JSON snippet, deployment manifest).

---

## Phase 6 — Polish + open follow-ups (½ day)

- Cost telemetry: log `sim:cost_estimate` events per tick when running on OpenRouter (token counts already come back in usage).
- Reward vault inflation: today the reward vault is seeded once at deploy. For 100-agent / 50-tick runs, it depletes too fast and `claim_rewards` starts returning early. Add a per-tick mint-and-fund step that maintains a target balance — only matters when staking-heavy scenarios run long enough.
- Unify `OPENROUTER_*_PRESET` env handling into one helper used by extraction + sim + report (avoid copy-paste of `@preset/${slug}` logic).

---

## Out of scope (call it now so we don't scope-creep)

- **On-chain veToken** (lock_until_tick + governance CPI). Engine-only approximation in Phase 4 is the cap.
- **StableSwap invariant** in the AMM. Constant-product is wrong for Curve's actual pools but does not change the failure-mode signature in our agent-vs-tokenomics framing.
- **Light Protocol compressed wallets.** Nice for 100-agent runs (cheaper SOL airdrops) but a separate workstream; current uncompressed flow handles ≤100 fine on devnet.
- **Multi-pass extraction (extract → critique → refine).** Single pass with the dashboard preset is fine for the hackathon. Revisit if extraction confidence routinely lands < 0.7.
- **Front-end changes.** Per the user's instruction, this whole plan is server-side. Frontend changes belong in a follow-up.

---

## Open questions for the user

Before kicking off, please confirm or course-correct:

1. **Curve depth (Phase 4):** is the engine-side veToken approximation acceptable, or do you want me to extend the staking program with `lock_until_tick` and add a `cast_vote_with_weight` CPI to governance? The latter is roughly +2 days and a real upgrade in fidelity.
2. **Roster expansion (Phase 3):** deterministic archetype scaling (proposed) or LLM-drafted personas from a goal? I'd default to deterministic for a hackathon — cheaper, reproducible.
3. **Reward vault funding:** do you want the inflation top-up (Phase 6 bullet) wired in Phase 2, or is one-shot seeding fine for now?
4. **`agentCount` cap:** 100? Higher? OpenRouter cost on 100 agents × 50 ticks × Sonnet-4.6 is non-trivial; recommend a hard 100 cap with a Sonnet→Haiku fallback for boost-tagged personas.
5. **Vesting beneficiary model (Phase 1.2):** "deployer plays team multisig" is the cheap path. The honest path is per-agent vesting where investor-class agents start with locked positions. I'd recommend the cheap path for v1; flag if you want per-agent.

---

## Effort summary

| Phase | Cost | Risk |
|---|---|---|
| 0 — Baseline | ½ day | none |
| 1 — Vesting wiring | 1–2 days | medium (program migration if we touch staking later) |
| 2 — Staking/governance honesty | 1 day | low |
| 3 — Preset + agent count | 1 day | low |
| 4 — Curve veToken (engine-side) | 1–2 days | medium (lots of engine state) |
| 5 — E2E Curve test | ½ day | low (real LLM costs ≈ a few cents) |
| 6 — Polish | ½ day | none |
| **Total** | **5–7 working days** | |

If you want to ship in 3 days, drop Phases 4 + 6 — those are the most "Curve-specific" pieces and the rest of the platform improves regardless.
