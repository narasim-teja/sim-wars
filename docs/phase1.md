# Phase 1 — Detailed Implementation Guide

## Session Status (as of 2026-04-13)

### What's Done

**Toolchain upgraded:**
- Rust: 1.94.1 (from 1.85.1)
- Solana CLI: 2.1.21 Agave (from 1.15.2)
- AVM: 1.0.0, Anchor CLI: 1.0.0 installed + set as current
- Bun: 1.3.9 (works, optional upgrade to 1.3.12+)

**Project bootstrapped — all source files created:**

```
sol/
├── Anchor.toml                          ✅ Created (needs program ID update after build)
├── Cargo.toml                           ✅ Workspace config
├── programs/
│   ├── token-mint/
│   │   ├── Cargo.toml                   ⚠️  Uses anchor-lang 0.27.0 — MUST UPDATE (see below)
│   │   └── src/lib.rs                   ✅ Full program: init_mint, configure, distribute, vesting, mint_from_burn
│   └── amm-dex/
│       ├── Cargo.toml                   ⚠️  Uses anchor-lang 0.27.0 — MUST UPDATE
│       └── src/lib.rs                   ✅ Full program: init_pool, add/remove liquidity, swap (x*y=k)
├── sim-engine/
│   ├── package.json                     ✅ Deps installed (@coral-xyz/anchor, @solana/web3.js, spl-token)
│   ├── tsconfig.json                    ✅
│   ├── bun.lock                         ✅
│   ├── src/
│   │   ├── types.ts                     ✅ All interfaces (SimulationConfig, AgentState, etc.)
│   │   ├── index.ts                     ✅ Main entry point — wires tick loop, agents, LUNA controller
│   │   ├── tick/
│   │   │   ├── tick-controller.ts       ✅ EventEmitter-based sequential tick loop
│   │   │   └── state-manager.ts         ✅ In-memory AMM, Gini calc, staking sim
│   │   ├── agents/
│   │   │   ├── orchestrator.ts          ✅ Batch LLM calls, validate actions, execute trades
│   │   │   └── personas.ts             ✅ 3 LUNA personas + 5 extended personas
│   │   ├── llm/
│   │   │   ├── ollama-client.ts         ✅ Ollama HTTP client, JSON parsing with fallbacks
│   │   │   └── prompt-builder.ts        ✅ Per-agent prompt template
│   │   ├── db/
│   │   │   └── database.ts             ✅ SQLite schema (simulations, tick_states, agent_actions)
│   │   └── scenarios/
│   │       └── luna-controller.ts       ✅ Reserve depletion, peg pressure, mint/burn hyperinflation
│   └── scenarios/
│       └── luna-ust.ts                  ✅ LUNA config (1B supply, 19.45% APY, $85 price)
├── .gitignore                           ✅
└── .git/                                ✅ Initialized, files staged (no commit yet)
```

**NOT created yet:**
- `scripts/deploy-programs.ts`
- `scripts/fund-agents.ts`
- `tests/token-mint.ts`
- `tests/amm-dex.ts`
- `sim-engine/scenarios/verify-luna.ts`
- `programs/staking/` and `programs/governance/` (Days 6-7)
- `frontend/` (Phase 2)

---

## Remaining Steps — Pick Up Here

### Step 1: Fix Anchor Version Mismatch (CRITICAL — do this first)

The Cargo.toml files reference `anchor-lang = "0.27.0"` but the installed CLI is now **1.0.0**.
You have two options:

**Option A: Use Anchor 0.30.1 (recommended, more stable)**
```bash
avm install 0.30.1
avm use 0.30.1
```
Then update both program Cargo.toml files:
```toml
# programs/token-mint/Cargo.toml AND programs/amm-dex/Cargo.toml
[dependencies]
anchor-lang = "0.30.1"
anchor-spl = "0.30.1"

[features]
# ...keep existing features...
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```
And update Anchor.toml:
```toml
[toolchain]
anchor_version = "0.30.1"
```

**Option B: Use Anchor 1.0.0 (latest, may have API changes)**
```bash
avm use 1.0.0  # already installed
```
Then update Cargo.toml files to `anchor-lang = "1.0.0"` / `anchor-spl = "1.0.0"`.
Note: Anchor 1.0.0 renamed `declare_id!` to `declare_program!` and has other breaking changes — the lib.rs files may need syntax updates.

### Step 2: Build Anchor Programs

```bash
cd /path/to/sol

# Clean any stale build artifacts
rm -rf target/

# Build
anchor build

# If successful, get the generated program IDs:
solana address -k target/deploy/token_mint-keypair.json
solana address -k target/deploy/amm_dex-keypair.json

# Update Anchor.toml [programs.devnet] with these IDs
# Update declare_id!() in each lib.rs with the matching ID
# Rebuild:
anchor build
```

### Step 3: Configure Solana Devnet Wallet

```bash
# Generate a deployer keypair (if not already done)
solana-keygen new --outfile ~/.config/solana/id.json --no-bip39-passphrase

# Set devnet
solana config set --url devnet

# Fund it
solana airdrop 5
# If rate-limited, try: solana airdrop 2 && sleep 10 && solana airdrop 2
```

### Step 4: Run the Simulation Engine (no Anchor needed!)

The sim-engine uses an **in-memory AMM simulation** for Phase 1 — it doesn't need deployed programs. You can run it right now with just Ollama:

```bash
# Terminal 1: Start Ollama
ollama serve

# Terminal 2: Pull model (if not already)
ollama pull qwen3:8b

# Terminal 3: Run simulation
cd sim-engine
bun run src/index.ts ../scenarios/luna-ust.ts
```

This will:
- Load the LUNA/UST scenario (1B supply, 19.45% APY, $85 price)
- Connect to Ollama (Qwen3-8B)
- Run 50 ticks with 3 agents (Whale, Yield Farmer, Retail Degen)
- Each tick: read state → build prompts → get LLM decisions → execute in-memory trades → persist to SQLite
- Display agent reasoning, price changes, reserve depletion, death spiral detection
- Save everything to `sim-data.sqlite`

**Expected output:** Death spiral in ~30-50 ticks (price $85 → <$1)

### Step 5: Deploy Programs to Devnet (after Step 2)

```bash
# Deploy both programs
anchor deploy

# Or deploy individually:
anchor deploy --program-name token_mint
anchor deploy --program-name amm_dex
```

### Step 6: Create Deployment Scripts

**`scripts/deploy-programs.ts`** — Automates:
1. Initialize token mint with LUNA params
2. Create a mock USDC/UST mint
3. Initialize AMM pool with initial liquidity ($85 price)
4. Log all addresses

**`scripts/fund-agents.ts`** — Automates:
1. Generate agent keypairs (save to `sim-engine/keys/`)
2. Airdrop SOL to each agent wallet
3. Create ATAs for both tokens
4. Distribute initial token holdings per persona config

### Step 7: Wire Sim Engine to On-Chain (replaces in-memory AMM)

Update `sim-engine/src/chain/` with:
- `connection.ts` — Solana provider setup using Helius RPC
- `sdk.ts` — TypeScript wrappers for Token Mint + AMM program instructions (using generated IDL)
- `action-executor.ts` — Signs and submits actual Solana transactions

Modify `orchestrator.ts` to use `action-executor.ts` instead of `state-manager.ts` for trade execution.

### Step 8: LUNA Backtest Verification

Create `sim-engine/scenarios/verify-luna.ts`:
```bash
bun run scenarios/verify-luna.ts <simulation-id>
```
Checks 5 criteria:
1. Price drops below $1 (from $85)
2. Staking ratio drops below 10%
3. Agent reasoning mentions "unsustainable" / "reserve"
4. Total supply increased (hyperinflation)
5. Clear cascade pattern: farmer → whale → degen

### Step 9: Staking + Governance Programs (Days 6-7)

Create `programs/staking/` and `programs/governance/` with the structs defined in [plan.md](plan.md#on-chain-architecture-anchor-programs).

Expand agent roster from 3 → 8 using the `EXTENDED_PERSONAS` already defined in `sim-engine/src/agents/personas.ts`.

### Step 10: First Commit

```bash
git add -A
git commit -m "Phase 1: Bootstrap project — Anchor programs, sim engine, LUNA backtest"
```

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
        → executeAction()             # swap on in-memory AMM (Phase 1)
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
| `programs/token-mint/src/lib.rs` | Anchor: mint, vesting, mint-from-burn (death spiral) |
| `programs/amm-dex/src/lib.rs` | Anchor: constant product AMM, swap, liquidity |

### Important Notes
- **Never `bun build`** the sim-engine — Bun's bundler breaks `@solana/web3.js`. Always use `bun run src/index.ts` (direct execution).
- The sim-engine's `@coral-xyz/anchor` dependency is `0.30.1` in package.json — update this to match whichever Anchor version you build with.
- The in-memory simulation (StateManager) and the on-chain programs are separate paths. Phase 1 uses in-memory; wiring to on-chain is Step 7 above.
