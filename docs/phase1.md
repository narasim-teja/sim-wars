# Phase 1 — Detailed Implementation Guide

## Session Status (as of 2026-04-19)

> **Phase 1 complete.** Days 1-7 shipped. Ready for Phase 2 (full roster + frontend).

### What's Done

**Toolchain:**
- Rust 1.94.1, Solana CLI 2.1.21 Agave, AVM 1.0.0, Anchor CLI 1.0.0, Bun 1.3.9.
- Anchor 0.30.1 → 1.0.0 migration complete (2026-04-14). See [anchor-1.0-migration.md](anchor-1.0-migration.md).
- Canonical build command: `anchor build --ignore-keys`.

**On-chain programs (Days 1-2, 6-7):**
- [programs/token-mint/src/lib.rs](../programs/token-mint/src/lib.rs) — `init_mint`, `configure`, `distribute`, vesting, `mint_from_burn`. Mint/auth + `checked_*` hardening intact.
- [programs/amm-dex/src/lib.rs](../programs/amm-dex/src/lib.rs) — `init_pool`, `add_liquidity`, `remove_liquidity`, `swap` (constant product), fee + slippage guards.
- [programs/staking/src/lib.rs](../programs/staking/src/lib.rs) — `initialize_pool`, `initialize_stake_account`, `stake`, `request_unstake`, `complete_unstake`, `claim_rewards`, `fund_reward_vault`, admin `set_tick`. Tick-denominated linear APY accrual, configurable lock + cooldown.
- [programs/governance/src/lib.rs](../programs/governance/src/lib.rs) — `initialize_governance`, `create_proposal`, `cast_vote`, `finalize_proposal`, `execute_proposal`, admin `set_tick`. Stake-weighted voting sourced from `staking::StakeAccount`; VoteReceipt PDA prevents double-voting; timelock gates execution.
- All four `Cargo.toml` at `anchor-lang/anchor-spl = "1.0.0"`. Governance depends on `staking` with `features = ["cpi"]` to read `StakeAccount`.
- `declare_id!` + `Anchor.toml` pinned (same ID for localnet + devnet):
  - `token_mint = 8hFR2Zw5tmX9ysKBPwGkhF9VxaV7pj24TDu6im7jPBXj`
  - `amm_dex = Dz3ZGCtmpqrxLs3GaKxc12wJGT7qNZNebdd6pzU5JnFx`
  - `staking = 2ecsTtNNuZUDSs19BfUx2yZ4n3WHTKKR2XfDWz6PAmdY`
  - `governance = Hk4eHkcr5njyntu4WEQuafVKkaK4LQJ8dTH5fqAArHFD`
- Build artifacts present: `target/deploy/{token_mint,amm_dex,staking,governance}.so`, `target/idl/*.json`, `target/types/*.ts`.

**Rust LiteSVM test harness (unlocked by the 1.0 migration):**
- [program-tests/Cargo.toml](../program-tests/Cargo.toml) — `litesvm 0.11`, `litesvm-token 0.11`, `solana-sdk/program 3.0`, `spl-token 9.0`, `anchor-lang 1.0.0`, + path deps on all four programs.
- [program-tests/tests/token_mint.rs](../program-tests/tests/token_mint.rs), [amm_dex.rs](../program-tests/tests/amm_dex.rs), [staking.rs](../program-tests/tests/staking.rs), [governance.rs](../program-tests/tests/governance.rs), [common/mod.rs](../program-tests/tests/common/mod.rs).
- Loads all four `.so` files via `add_program_from_file` with canonical program IDs.
- **Current status: 19/19 tests passing** (3 token_mint + 4 amm_dex + 6 staking + 6 governance). Staking covers APY accrual, lock period, cooldown, authority gating, monotonic tick, empty-vault cap. Governance covers happy-path proposal lifecycle, threshold rejection, double-vote rejection via VoteReceipt init, finalize-before-expiry, quorum-unmet failure, late-vote rejection.

**Sim engine (Days 3-4):**
- [sim-engine/package.json](../sim-engine/package.json) — `@anchor-lang/core ^1.0.0`, `@solana/web3.js ^1.98.0`, `@solana/spl-token ^0.4.12`.
- [src/index.ts](../sim-engine/src/index.ts) wires tick loop, LUNA controller, orchestrator, chain executor.
- [src/tick/tick-controller.ts](../sim-engine/src/tick/tick-controller.ts), [src/tick/state-manager.ts](../sim-engine/src/tick/state-manager.ts) — tick engine + in-memory AMM / Gini / staking.
- [src/agents/orchestrator.ts](../sim-engine/src/agents/orchestrator.ts) — batch LLM calls, validation, now routes trades to `ChainExecutor` (on-chain) while stake/unstake stay in-memory for Phase 1.
- [src/agents/personas.ts](../sim-engine/src/agents/personas.ts) — `LUNA_PERSONAS` (3), `EXTENDED_PERSONAS` (5), and `ALL_PHASE1_PERSONAS` (8). Extended personas now carry numeric decision triggers + `stakedFraction` so the 8-agent LUNA scenario has realistic initial staking.
- [src/llm/ollama-client.ts](../sim-engine/src/llm/ollama-client.ts), [src/llm/prompt-builder.ts](../sim-engine/src/llm/prompt-builder.ts) — Ollama HTTP + JSON parsing with fallbacks + per-agent prompts.
- [src/db/database.ts](../sim-engine/src/db/database.ts) — SQLite (`simulations`, `tick_states`, `agent_actions`).
- [src/scenarios/luna-controller.ts](../sim-engine/src/scenarios/luna-controller.ts) — reserve drain, peg pressure, mint/burn hyperinflation.
- [scenarios/luna-ust.ts](../sim-engine/scenarios/luna-ust.ts) — LUNA/UST config (1B supply, 19.45% APY, $85). Now activates all 8 agents via `ALL_PHASE1_PERSONAS`.

**On-chain wiring (Step 7, done):**
- [src/chain/connection.ts](../sim-engine/src/chain/connection.ts) — `AnchorProvider`/`Wallet` setup.
- [src/chain/sdk.ts](../sim-engine/src/chain/sdk.ts) — `Program<Idl>` wrappers for token-mint + amm-dex.
- [src/chain/action-executor.ts](../sim-engine/src/chain/action-executor.ts) — signs + submits actual txs; enhanced simulation (commit `5ebcce3`).

**Deployment scripts (Step 6, done):**
- [sim-engine/scripts/deploy-programs.ts](../sim-engine/scripts/deploy-programs.ts) — init mint, mock USDC, init pool with initial liquidity.
- [sim-engine/scripts/fund-agents.ts](../sim-engine/scripts/fund-agents.ts) — keypairs, SOL airdrop, ATAs, per-persona distribution.

**Day 5 LUNA backtest:**
- [sim-engine/scenarios/verify-luna.ts](../sim-engine/scenarios/verify-luna.ts) — 5-criteria backtest verifier.

### What's left in Phase 1

All Phase 1 milestones shipped. Remaining items are Phase 2 scope or intentional Phase 1 deferrals:

**Phase 2 (next):**
- Sim-engine wiring of on-chain staking + governance: extend [src/chain/sdk.ts](../sim-engine/src/chain/sdk.ts) and [src/chain/action-executor.ts](../sim-engine/src/chain/action-executor.ts) to call `staking.stake/unstake/claim_rewards` and `governance.create_proposal/cast_vote`. Replace in-memory `StateManager.stake/unstake` with on-chain calls. Handle the `vote_yes`/`vote_no`/`propose` action types in the orchestrator's `executeAction` switch (they currently fall through to hold).
- Full 20-agent roster (12 more personas).
- Frontend (`frontend/`).

**Intentional Phase 1 deferrals:**
- TypeScript mirror tests (`tests/token-mint.ts`, `tests/amm-dex.ts`) — the Rust LiteSVM suite in [program-tests/](../program-tests/) covers this role.
- `execute_proposal` has no on-chain side effect yet — it sets the status flag only; Phase 2 sim-engine reads the flag and reshapes state (e.g., parameter change, treasury redirect).

---

## How to run what's built

**In-memory sim (fastest feedback loop — no chain needed):**
```bash
# Terminal 1
ollama serve
# Terminal 2 (first time only)
ollama pull qwen3:8b
# Terminal 3
cd sim-engine && bun run src/index.ts ../scenarios/luna-ust.ts
```

**On-chain sim against localnet:**
```bash
# Terminal 1
solana-test-validator
# Terminal 2
anchor deploy
cd sim-engine
bun run scripts/deploy-programs.ts
bun run scripts/fund-agents.ts
bun run src/index.ts ../scenarios/luna-ust.ts
```

**LUNA backtest verification:**
```bash
cd sim-engine && bun run scenarios/verify-luna.ts <simulation-id>
```
Checks: (1) price < $1 (from $85), (2) staking ratio < 10%, (3) reasoning mentions "unsustainable"/"reserve", (4) total supply inflated, (5) cascade pattern farmer → whale → degen.

**Rust program tests:**
```bash
anchor build --ignore-keys
cargo test -p program-tests
```

---

## Days 6-7 implementation notes

1. **Staking program** — tick-denominated linear APY accrual: `rewards = amount × base_apy_bps × ticks_elapsed / (10_000 × ticks_per_year)`. Two-step unstake (request → cooldown → complete) so the on-chain timing matches the in-memory scenario model. `set_tick` is authority-gated and monotonic — the sim engine advances it once per tick. `fund_reward_vault` lets the authority seed rewards up front (phase 1 treats the reward source as an admin-funded pool; inflationary minting is deferred).
2. **Governance program** — `Governance` is bound to one `staking_pool`. Voting weight is read directly from `staking::StakeAccount` (governance depends on `staking` with `features = ["cpi"]`). `cast_vote` inits a `VoteReceipt` PDA keyed by `(proposal, voter)` — replay/double-vote rejection is automatic. Lifecycle: `create → cast_vote × N → set_tick past expiry → finalize → set_tick past timelock → execute`.
3. **Agent roster** — [scenarios/luna-ust.ts](../sim-engine/scenarios/luna-ust.ts) now imports `ALL_PHASE1_PERSONAS` (8 agents: 3 LUNA + 5 extended). Each extended persona was augmented with numeric decision triggers and a `stakedFraction` so they contribute to the initial staked-supply number.
4. **Deferred sim-engine wiring** — the staking/governance programs compile + are tested on-chain, but the sim engine still uses `StateManager.stake/unstake` in-memory. Hooking the orchestrator into `staking::stake/unstake` is Phase 2 work; the chain layer already has the `Program<Idl>` wrapper pattern via [src/chain/sdk.ts](../sim-engine/src/chain/sdk.ts).

---

## LLM Model Decision: Qwen3-8B

**Chosen: Qwen3-8B** via Ollama

| Model | JSON Output | Financial Reasoning | Speed (tok/s) | Memory |
|-------|------------|-------------------|---------------|--------|
| **Qwen3-8B** | Native grammar constraints | 83.2% (MATH) | ~45 | ~10GB |
| Llama 3.1 8B | Native JSON mode | 80.5% | ~45 | ~10GB |
| Gemma 3 8B | Prompt-based only | Unproven at 8B | ~40 | ~9.6GB |
| Mistral 7B | Prompt-based | 6/10 | ~55 | ~7GB |
| Phi-4-mini | Structured | 82.5% (AIME) | ~25 | ~3.8GB |

**Why Qwen3-8B:**
- Best math/financial reasoning at 8B scale
- Native structured JSON output (grammar-based, not just prompt-based)
- Thinking mode toggle — deep reasoning for complex ticks, fast for simple ones
- Proven in financial simulation research (TradingGroup framework)
- Full MLX acceleration on Apple Silicon via Ollama

**Fallback:** If Qwen3 JSON output is unreliable in practice, switch to `llama3.1:8b` (same command: `ollama pull llama3.1:8b`, change model name in `ollama-client.ts` constructor).

**Phase 2 scaling note:** 5 parallel 8B instances need ~50GB RAM (exceeds 32GB M2 Max). Solutions: Q3 quantization, sequential batching (4 batches of 5 = ~60s total), or use Mistral 7B for simpler agent personas and Qwen3 for complex ones.

---

## Architecture Quick Reference

### Sim Engine Flow (per tick)
```
TickController.start()
  → emit "tick:start"
    → StateManager.readState()        # read AMM reserves, compute Gini, price history
    → LunaController.processTick()    # drain reserve, compute peg, hyperinflation
    → AgentOrchestrator.processTickBatch()
      → for each agent batch:
        → buildAgentPrompt()          # inject market state + persona + constraints
        → OllamaClient.generateBatch() # parallel LLM calls
        → validateAction()            # clamp amounts, check balances
        → ChainExecutor.execute()     # sign + submit swap tx against deployed AMM
        → SimDatabase.insertAction()  # persist to SQLite
    → TickController.markTickComplete()
```

### Key Files to Understand
| File | Purpose |
|------|---------|
| `sim-engine/src/index.ts` | Main entry, wires everything, runs tick loop |
| `sim-engine/src/tick/state-manager.ts` | In-memory AMM (x*y=k), Gini coefficient, staking sim |
| `sim-engine/src/agents/orchestrator.ts` | Batch LLM calls, validate + execute agent decisions |
| `sim-engine/src/llm/ollama-client.ts` | Ollama HTTP API, JSON parsing with 4 fallback strategies |
| `sim-engine/src/scenarios/luna-controller.ts` | LUNA reserve drain, peg pressure, hyperinflation logic |
| `sim-engine/scenarios/luna-ust.ts` | LUNA/UST config: 19.45% APY, $85 price, 3B reserve |
| `sim-engine/src/agents/personas.ts` | 3 LUNA personas + 5 extended (for 8-agent mode) |
| `sim-engine/src/chain/{connection,sdk,action-executor}.ts` | Anchor provider, Program<Idl> wrappers, on-chain tx submission |
| `sim-engine/scripts/{deploy-programs,fund-agents}.ts` | Bootstrap mint/pool/liquidity and per-persona agent funding |
| `sim-engine/scenarios/verify-luna.ts` | 5-criteria LUNA backtest verifier |
| `programs/token-mint/src/lib.rs` | Anchor: mint, vesting, mint-from-burn (death spiral) |
| `programs/amm-dex/src/lib.rs` | Anchor: constant product AMM, swap, liquidity |
| `program-tests/tests/{token_mint,amm_dex}.rs` | LiteSVM Rust test harness (happy + negative paths) |

### Important Notes
- **Never `bun build`** the sim-engine — Bun's bundler breaks `@solana/web3.js`. Always use `bun run src/index.ts` (direct execution).
- TS Anchor package is `@anchor-lang/core ^1.0.0` (the old `@coral-xyz/anchor` was replaced in the 1.0 migration).
- Trades now execute on-chain via `ChainExecutor`. Stake/unstake remain in-memory (StateManager) until the Day 6-7 staking program ships.
- Build programs with `anchor build --ignore-keys` (Anchor 1.0 spurious transient-keypair check). LiteSVM tests load `.so` by canonical program ID, so the mismatch doesn't affect them.
