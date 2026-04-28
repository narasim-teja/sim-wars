# Tokenomics War Game — Full Project Spec
### SWARM × Colosseum Frontier Hackathon | Solo | 4 Weeks

---

## One-Liner

Deploy your token economy on Solana devnet, unleash 20 LLM-powered adversarial agents, watch it survive or die in real time — validated against LUNA/UST, the largest tokenomics collapse in history.

---

## The Pitch

Bad tokenomics kills more crypto projects than bad code. The current pre-launch validation process is: write a whitepaper, run a spreadsheet, launch and pray. **There is no adversarial simulation layer.**

Tokenomics War Game is the first platform where protocol teams upload their whitepaper or mechanism design, the system extracts token parameters automatically, deploys real Anchor programs on Solana devnet, and releases 20 LLM-powered agents — whales, degens, governance attackers, sybil wallets, MEV bots — to find every failure mode before mainnet.

The hero artifact: **feed the system LUNA/UST's exact parameters. The agents reproduce the death spiral. Now imagine if Do Kwon had this tool.**

---

## Track Fit

**Primary: RFB 04 — Emergent Agent Economies**
> "Agents with different goals interacting in a real-money Solana environment, observing emergent economic structures."

**Secondary: RFB 05 — Multi-Agent Orchestration**
> 20 agents coordinating attacks, splitting roles, self-organizing around governance proposals.

**Secondary: RFB 01 — Agent Discovery**
> Agents discover optimal attack vectors and data sources autonomously each tick.

---

## Judging Alignment

| Criterion | Weight | How We Win |
|---|---|---|
| Innovation | 40% | First LLM-adversarial tokenomics sim with on-chain execution + historical backtest. Zero prior art in 5,400+ Colosseum submissions. |
| Agentic Sophistication | 30% | 20 agents reasoning about future state, other agents' behavior, and coordinating attacks. Not automation — genuine LLM decisions every tick. |
| Traction | 30% | LUNA backtest as viral artifact. Free stress-tests for other hackathon teams during Week 4. Target: 5-10 LOIs + 10-20 GitHub stars. |

---

## UI/UX Design Direction

Inspired by MiroFish's interface philosophy:

**Left Panel — Live Agent Graph (full screen, dark bg)**
- Force-directed graph where each node is an agent wallet
- Node color = agent type (whale=red, degen=orange, governance attacker=purple, MEV=yellow, yield farmer=green, long-term holder=blue, sybil cluster=pink)
- Edge = transaction between agents this tick (animated, fades after 3 ticks)
- Node size = current token holdings (grows as whale accumulates)
- Click any node → side panel shows agent identity, last 5 decisions + LLM reasoning, wallet balance, on-chain tx history
- Red edges = sell pressure, green = buy/stake, purple = governance action

**Right Panel — Split view**
- Top half: live metrics dashboard
  - Token price chart (Recharts, real-time updates every tick)
  - Gini coefficient chart (wealth concentration over time)
  - Staking ratio %
  - Governance power distribution (pie)
  - Agent action feed (scrolling log: "Whale_03 sold 2.4M tokens | reasoning: detected yield farmer exit cascade")
- Bottom half: simulation console (MiroFish-style terminal)
  - Live system logs
  - Current tick, elapsed time, tx count
  - Threat level indicator (green → yellow → red → DEATH SPIRAL)

**Top Nav**
- Step indicator: `1. Configure → 2. Deploy → 3. Simulate → 4. Report` (MiroFish-style step progress)
- Status badge: `● RUNNING` / `● COMPLETED` / `● DEATH SPIRAL DETECTED`

**Setup Flow (pre-sim)**
- Upload whitepaper PDF / paste mechanism doc → Claude extracts parameters automatically
- Or manual config form: supply, allocation %, vesting schedule, staking APY, governance thresholds, fee structure
- Select agent roster (default: all 20, can customize count/composition)
- Select scenario: Custom / LUNA Backtest / CRV Stress Test
- One-click deploy → Anchor programs deploy to devnet → sim starts

**Post-sim Report**
- MiroFish-style structured report panel
- Sections: Executive Summary / Failure Modes Detected / Agent Behavior Analysis / Recommendations / Resilience Score (0-100)
- Downloadable PDF
- Shareable link (public URL for the report)

---

## Agent Roster (20 Agents)

### Aggressive Attackers (6)
| ID | Persona | Strategy | Goal |
|---|---|---|---|
| WHALE_01-02 | Whale (x2) | Accumulate silently, coordinate dump | Maximize exit value, destabilize price |
| GOV_01-02 | Governance Attacker (x2) | Accumulate votes, pass self-serving proposals | Redirect treasury, change parameters |
| SYBIL_01 | Sybil Cluster | Controls 5 sub-wallets, games airdrops/snapshots | Maximize airdrop allocation |
| MEV_01 | MEV Bot | Front-runs large trades, sandwich attacks | Extract value from every large tx |

### Opportunistic (7)
| ID | Persona | Strategy | Goal |
|---|---|---|---|
| FARMER_01-03 | Yield Farmer (x3) | Chase highest APY, exit when better yield exists | Maximize yield, zero loyalty |
| DEGEN_01-03 | Retail Degen (x3) | FOMO buys on price rise, panic sells on drop | Ride momentum, usually wrong |
| ARB_01 | Arbitrageur | Rational price discrepancy exploiter | Extract arb between pools |

### Stabilizing (4)
| ID | Persona | Strategy | Goal |
|---|---|---|---|
| HOLDER_01-02 | Long-term Holder (x2) | Stakes and holds, votes conservatively | Long-term protocol success |
| TREASURY_01 | Protocol Treasury | Buybacks on dips, liquidity provision | Defend peg/price |
| LP_01 | Liquidity Provider | Provides/removes liquidity based on IL risk | Fee income, minimize IL |

### Researcher (3)
| ID | Persona | Strategy | Goal |
|---|---|---|---|
| ANALYST_01 | On-chain Analyst | Reads all agent actions, publishes "reports" | Inform other agents (info propagation) |
| INSIDER_01 | Informed Trader | Has advance knowledge of treasury actions | Trade on insider timing |
| PANIC_01 | Panic Seller | Sells on any negative signal, triggers cascades | Risk aversion to extreme |

---

## Agent Architecture

### Per-Agent Prompt Structure (TypeScript)

```typescript
interface AgentState {
  persona: AgentPersona
  walletAddress: string
  holdings: { token: number; staked: number; usdc: number }
  memory: AgentAction[]  // last 10 actions
  observedActions: AgentAction[]  // other agents' recent actions
}

interface SimulationState {
  tick: number
  tokenPrice: number
  priceHistory: number[]  // last 20 ticks
  totalSupply: number
  stakedSupply: number
  stakingAPY: number
  giniCoefficient: number
  governanceProposals: Proposal[]
  topHolders: HolderSnapshot[]
  recentLargeTrades: Trade[]  // trades > 1% of supply
}

// LLM prompt per tick
const buildAgentPrompt = (agent: AgentState, sim: SimulationState) => `
You are ${agent.persona.name} in a live token economy simulation on Solana.

YOUR IDENTITY:
${agent.persona.systemPrompt}

CURRENT MARKET STATE (Tick ${sim.tick}):
- Token price: $${sim.tokenPrice} (was $${sim.priceHistory.at(-5)} 5 ticks ago)
- Your holdings: ${agent.holdings.token} tokens, ${agent.holdings.staked} staked, $${agent.holdings.usdc} USDC
- Staking APY: ${sim.stakingAPY}% (${sim.stakingAPY > 15 ? 'HIGH - unsustainable?' : 'normal range'})
- Total staked: ${(sim.stakedSupply / sim.totalSupply * 100).toFixed(1)}% of supply
- Wealth concentration (Gini): ${sim.giniCoefficient.toFixed(3)} ${sim.giniCoefficient > 0.7 ? '⚠️ HIGH CENTRALIZATION' : ''}
- Recent large trades: ${sim.recentLargeTrades.map(t => `${t.actor} ${t.action} ${t.amount}`).join(', ')}
- Active governance proposals: ${sim.governanceProposals.length > 0 ? sim.governanceProposals[0].description : 'none'}

YOUR RECENT ACTIONS: ${agent.memory.slice(-5).map(a => a.summary).join(' → ')}
OTHER AGENTS RECENTLY: ${agent.observedActions.slice(-5).map(a => a.summary).join(', ')}

Based on your persona and goals, what do you do this tick?
Respond with JSON only:
{
  "action": "buy|sell|stake|unstake|vote_yes|vote_no|propose|hold",
  "amount": <number or null>,
  "reasoning": "<1-2 sentence explanation>",
  "threat_assessment": "<what failure mode are you sensing, if any>"
}
`
```

### Orchestration Design (MiroFish-inspired)

```
SimulationEngine (Bun, main process)
├── TickController — manages tick timing (5s dev, 400ms prod)
├── StateManager — reads devnet state via Helius RPC
├── AgentOrchestrator
│   ├── AgentPool (20 agents, run in parallel batches of 5)
│   ├── LLMRouter — routes to Ollama (Qwen3 8B) per agent
│   ├── ActionExecutor — signs + submits Solana txs
│   └── MemoryStore — SQLite, per-agent action history
├── ObservationLayer
│   ├── Yellowstone gRPC subscriber — real-time tx stream
│   ├── MetricsComputer — Gini, concentration, price impact
│   └── ThreatDetector — death spiral pattern recognition
├── WebSocketServer — pushes state to Next.js frontend
└── ReportGenerator — post-sim Claude API call
```

### Parallelism Strategy
- 20 agents split into 4 batches of 5
- Each batch runs LLM calls concurrently via `Promise.all`
- Qwen3 8B on Mac Studio M2 Max (32GB): ~2-3s per agent call
- Batch of 5 parallel ≈ 3s, 4 batches sequential ≈ 12s total
- Total tick time ≈ 15s (LLM) + tx execution ≈ ~5s per tick in dev mode
- Tick interval set to 20s in dev to allow all agents to complete

---

## On-Chain Architecture (Anchor Programs)

### Programs to Deploy (Solana Devnet)

**1. Token Mint Program**
- Parameterizable at deploy: total supply, decimals, mint authority
- Vesting: cliff + linear unlock, configurable per allocation bucket
- Transfer hooks: compliance checks (used for simulation gating)

**2. AMM DEX Program (Constant Product, Meteora-inspired)**
- Full constant product AMM: x * y = k
- Configurable fee tiers (0.01%, 0.05%, 0.3%, 1%)
- Concentrated liquidity ranges (DLMM-style bins)
- Price impact calculation
- Slippage protection
- LP token minting/burning
- Protocol fee collection

**3. Staking Program**
- Stake/unstake with configurable lock periods
- Dynamic APY (adjusts based on total staked %)
- Reward distribution (inflationary or from treasury)
- Unstaking penalty/cooldown period
- Tracks staking power per wallet (for governance weight)

**4. Governance Program**
- Token-weighted voting
- Proposal creation (requires minimum token threshold)
- Voting period (configurable in ticks)
- Quorum requirements
- Executable proposals (can call other programs)
- Veto mechanism (treasury can veto)

**5. Oracle Program (simplified)**
- Price feed updated each tick by the simulation engine
- Historical price storage (last 100 ticks)
- TWAP calculation
- Used by AMM for reference price

### Program Deployment Flow
```typescript
// SimulationConfig from whitepaper extraction
interface SimulationConfig {
  token: {
    totalSupply: number
    decimals: number
    allocations: { name: string; percent: number; vestingMonths: number }[]
  }
  amm: {
    initialLiquidity: number
    initialPrice: number
    feeTier: number
    binStep: number  // for DLMM-style
  }
  staking: {
    baseAPY: number
    maxAPY: number
    lockPeriodTicks: number
    unstakePenaltyPercent: number
  }
  governance: {
    proposalThresholdPercent: number
    quorumPercent: number
    votingPeriodTicks: number
    timelockTicks: number
  }
}
```

---

## Whitepaper Extraction (UX Flow)

```
User uploads PDF / pastes text
  → Claude API (extraction prompt):
    "Extract the following tokenomics parameters from this document.
     If a value is not specified, mark as null and use the default.
     Return as SimulationConfig JSON."
  → Pre-fills config form with extracted values
  → User reviews/edits
  → One-click deploy
```

**Extraction prompt handles:**
- Supply schedules and allocation tables
- Vesting cliff/linear language ("18-month cliff, 36-month linear")
- Staking APY mentions ("target 15-20% staking rewards")
- Governance thresholds ("proposals require 1% of supply")
- Fee structures ("0.3% swap fee, 50% to treasury")

---

## Tech Stack

### Frontend
- **Framework**: Next.js 15 (App Router)
- **UI**: shadcn/ui + Tailwind CSS
- **Graph viz**: D3.js force simulation (agent network graph)
- **Charts**: Recharts (price, Gini, staking ratio, governance)
- **Real-time**: WebSocket client (simulation state stream)
- **Animations**: Framer Motion (edge fade, node pulse on action)
- **Report**: React-to-PDF for downloadable reports

### Simulation Engine
- **Runtime**: Bun
- **Language**: TypeScript — kept deliberately. See [Architectural Review — Post-Phase 1](#architectural-review--post-phase-1-2026-04-19) for the rationale (Solana tooling is TS-native; we are not using CAMEL-AI/OASIS).
- **Tick loop**: Custom EventEmitter-based tick controller
- **Agent LLM — provider-agnostic via OpenAI-compatible adapter**:
  - Dev (local): Ollama (Qwen3 8B, zero API cost, Mac Studio)
  - Prod / demo: OpenRouter (hosted Qwen/Llama/Claude via one unified OpenAI-compatible endpoint)
  - Dual-model routing ("boost" pattern, stolen from MiroFish): fast/cheap model for simple personas (DEGEN, PANIC, FARMER), reasoning model for complex ones (WHALE, GOV, ANALYST, INSIDER)
  - Single `LLMClient` interface behind a `LLM_PROVIDER=ollama|openrouter` env switch
- **Report generation**: Claude API (single call post-sim, claude-sonnet-4-6)
- **State storage**: SQLite via Bun's built-in SQLite
- **Agent memory (per-agent, cross-tick)**: SQLite + lightweight in-memory embedding recall for Phase 2; Zep Cloud or mem0 as an optional Phase 3 upgrade for graph/temporal recall
- **Sim-worker isolation**: Sim runs as a child Bun process spawned by the API server; API ↔ worker talk over **filesystem IPC** (`runs/<sim_id>/commands/`, `runs/<sim_id>/events/`). Pattern borrowed from MiroFish — simple, debuggable, restart-safe, no broker
- **WebSocket server**: Bun native WebSocket (API server → Next.js frontend). REST polling is not sufficient; our tick cadence is 20s in dev and the action feed is the showcase.

### Solana
- **Framework**: Anchor (Rust)
- **Network**: Devnet (development), Testnet (demo)
- **RPC**: Helius (state reads, account fetching)
- **Real-time**: Yellowstone gRPC (tx streaming to observation layer)
- **Compression**: Light Protocol (ZK-compressed agent wallets, 1000+ cheap)
- **Agent SDK**: Solana Agent Kit v2 (native Solana actions for agents)
- **Wallet**: Keypair per agent, funded from simulation faucet

### Infrastructure
- **Local dev**: Mac Studio M2 Max (32GB) — Ollama + Bun + Anchor
- **Containerization**: Single `Dockerfile` (multi-stage: Bun for sim-engine + Node for Next.js build) + `docker-compose.yml` for one-shot `docker compose up` demos. Pattern borrowed from MiroFish's single-container `concurrently` layout. Three services in compose: `sim-engine` (Bun), `frontend` (Next.js), `ollama` (optional, disabled when `LLM_PROVIDER=openrouter`).
- **Deployment**: Railway (sim-engine API + WebSocket), Vercel (Next.js frontend). Ollama not deployable on Railway — prod must use OpenRouter.
- **Monitoring**: Helius webhooks for on-chain events
- **Secrets**: `.env.example` checked in; Railway/Vercel env vars for prod. `OPENROUTER_API_KEY`, `HELIUS_API_KEY`, `ANTHROPIC_API_KEY` (report generation).

---

## Architectural Review — Post-Phase 1 (2026-04-19)

> Written after Phase 1 shipped. Captures structural decisions taken before Phase 2 opens so we don't refactor mid-sprint. See [phase1.md](phase1.md) for what's already built.

### Phase 1 recap — what we already have

- 4 Anchor 1.0 programs deployed (token-mint, amm-dex, staking, governance), 19/19 LiteSVM Rust tests passing.
- Sim engine on Bun + TypeScript with: tick controller, state manager (in-mem AMM + Gini + staking), orchestrator, Ollama HTTP client with 4-fallback JSON parsing, SQLite persistence (`simulations`, `tick_states`, `agent_actions`), on-chain `ChainExecutor` for swaps.
- LUNA scenario with 8 personas reproduces the death spiral end-to-end.

The gap between "what Phase 1 proved" and "what Phase 2 needs" is less about code and more about **structure** — once 20 agents run live on a public URL, the choices below become expensive to change.

### MiroFish reference read

We're explicitly drafting off MiroFish ([github.com/666ghj/MiroFish](https://github.com/666ghj/MiroFish)) for orchestration patterns. Below is what we adopt, adapt, and skip.

| MiroFish pattern | Our decision | Notes |
|---|---|---|
| Python + Flask backend, OASIS/CAMEL-AI swarm engine | **Skip the language switch.** Keep Bun + TypeScript. | MiroFish chose Python because OASIS/CAMEL is Python-native. We don't use those. Every Solana dep we need (`@solana/web3.js`, `@anchor-lang/core`, `@solana/spl-token`, Helius/Yellowstone SDKs) is TS-native. Switching to Python means writing subprocess shims for every chain call — pure loss. The "we're just using LLM wrappers" assumption breaks once on-chain execution is core. TS stays. |
| OpenAI-compatible LLM endpoint + optional `LLM_BOOST_*` fallback model | **Adopt.** | Refactor `OllamaClient` into a generic `LLMClient` behind an OpenAI-compatible adapter. Two env triplets: primary (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`) and boost (`LLM_BOOST_*`). Orchestrator routes per-persona: reasoning model for WHALE/GOV/ANALYST/INSIDER, fast model for DEGEN/PANIC/FARMER. Works against Ollama (dev) **and** OpenRouter (prod/demo) with zero code change — OpenRouter speaks OpenAI schema. |
| Zep Cloud for per-agent long-term memory (GraphRAG) | **Defer.** SQLite + optional vector recall in Phase 2. Revisit in Phase 3. | We already have per-agent action history in SQLite. Phase 2 adds lightweight embedding-based recall (top-k similar past ticks). Zep is a paid external service — inappropriate for an open-source hackathon artifact by default, and our ticks are short-horizon enough that a 10-action window mostly suffices. Keep `MemoryStore` interface narrow so Zep/mem0 plugs in later behind the same shape. |
| LLM-drafted simulation config from user goal | **Adopt in Phase 3.** | Phase 3 already has "whitepaper extraction"; widen it to also let an LLM draft `SimulationConfig` defaults from a plain-English goal ("stress-test a memecoin launch with high initial unlock"). Same Claude call, different prompt branch. |
| Filesystem IPC between API server and sim subprocess (`commands/`, `responses/` dirs) | **Adopt.** | Today `src/index.ts` is one process — tick loop, orchestrator, WebSocket all together. A crashed LLM call or broken tx can nuke the whole sim. Phase 2 splits this: an **API/WebSocket server** (long-lived) spawns a **SimWorker** child process per run. They talk over `runs/<sim_id>/commands/*.json` and `runs/<sim_id>/events/*.ndjson`. Pause/resume/abort become file-writes; front-end UI maps 1:1 to filesystem events. Survives restarts, easy to inspect, no broker. |
| REST polling (Vue → Flask) | **Skip. Keep WebSockets.** | MiroFish ticks are minutes long so polling is fine. Ours are ~20s with an action feed that's supposed to feel alive. Bun native WS server → Next.js client, one subscription per sim. |
| Single Docker container via `concurrently` | **Adopt, but split into compose services.** | Bun sim-engine and Next.js frontend belong in separate images — different base, different ports, different deploy target (Railway vs Vercel). `docker-compose.yml` composes them for local/demo parity. See [Infrastructure](#infrastructure). |

### Language & runtime — locked in

- **Sim engine stays on Bun + TypeScript.** Already passes LUNA backtest; every Solana SDK is TS-native; subprocess-to-Python would be a regression. The earlier "we're just using LLM wrappers" take underweights the on-chain half of the system.
- **Programs stay on Anchor 1.0 / Rust.** No change.
- **Frontend stays on Next.js 15.** App Router + shadcn/ui. WebSocket client only — no SSR for the live dashboard (it's a client component reading a WS stream).

### LLM provider strategy — dev-to-prod ramp

```
Phase 1 (done):       Ollama + Qwen3 8B, local-only, zero cost.
Phase 2 (refactor):   Introduce LLMClient adapter. Ollama is one provider.
                      Unit-test with a mock provider. Ship "boost model" split.
Phase 3 (cloud):      OpenRouter provider. One API key → Qwen, Llama, Claude,
                      GPT all available. Switch via env. Ollama optional in prod.
Post-hackathon:       Per-tier routing — cheap Qwen for retail personas,
                      mid-tier Llama-70B for attackers, Claude Opus/Sonnet for
                      report generation. OpenRouter bills per call.
```

**Why OpenRouter, not direct OpenAI/Anthropic/provider APIs:**
- One account, one key, 300+ models — swap models without code/deploy changes.
- OpenAI-compatible schema, so the adapter written against Ollama works unmodified.
- Usage dashboards and spend caps per key (hackathon budget sanity).
- Lets us advertise to contributors: "runs on anything OpenAI-compatible" = lowest onboarding friction.

### Sim-engine process model — Phase 2 refactor

Current: one long-running Bun process does everything. Moving to:

```
┌────────────────────────────────────────────────────────┐
│  API / WebSocket Server (Bun)                          │
│  - REST: create sim, pause, resume, abort              │
│  - WS: broadcast tick events to frontend               │
│  - Writes runs/<sim_id>/commands/*.json                │
│  - Tails  runs/<sim_id>/events/*.ndjson                │
└────────────────────────────────────────────────────────┘
            │ spawns child, waits on events dir
            ▼
┌────────────────────────────────────────────────────────┐
│  SimWorker (Bun, one per active run)                   │
│  - TickController + StateManager                       │
│  - AgentOrchestrator → LLMClient (Ollama|OpenRouter)   │
│  - ChainExecutor → Solana devnet                       │
│  - ReportGenerator                                     │
│  - Polls commands/, writes events/                     │
│  - Owns SQLite file per run                            │
└────────────────────────────────────────────────────────┘
```

- Worker crashes don't take down the API.
- Multiple concurrent sims = multiple worker processes, same code.
- `runs/<sim_id>/` is self-contained: events, SQLite, final report. One `tar` = full reproducible artifact.

### Docker & deployment plan

Phase 3 Day 7 replaces the ad-hoc "`bun run` in one terminal" with:

- `sim-engine/Dockerfile` — Bun runtime, installs `anchor-lang` types, mounts `runs/` volume.
- `frontend/Dockerfile` — Node build → Next.js standalone → nginx or `next start`.
- `docker-compose.yml` — `sim-engine`, `frontend`, optional `ollama` (commented out for OpenRouter prod).
- `docker-compose.dev.yml` — overlay that mounts source for hot reload.
- `.env.example` — every env var the project reads.

Prod deploy split:
- Frontend → Vercel (auto from `main`).
- Sim-engine + WS → Railway (one service, persistent disk for `runs/`, OpenRouter only).
- Anchor programs stay on Solana devnet (free, shared across all frontend visitors).

### Open-source readiness (pre-submission)

We're shipping this public. Structural choices to make now so we don't rewrite commit history later:

- **License**: MIT. Add `LICENSE` in Phase 3 Day 7 alongside the README.
- **Secrets hygiene**: no API keys in commits. `.env.example` only. Audit `git log -p -- '*.env*'` before going public.
- **No vendor lock-in narrative**: provider-agnostic LLM, OpenAI-compatible by default.
- **Reproducibility**: a fresh clone → `docker compose up` → working LUNA demo in <5 min. This is part of the submission scoring.
- **Contribution ergonomics**: `CONTRIBUTING.md` with "add a new persona" and "add a new scenario" recipes. Phase 4 traction strategy depends on people forking and running their own sims.
- **Shape the demo for forkability**: every default (20 agents, 20s tick, LUNA scenario) should be overridable via a single YAML/JSON file, not code edits.

### Phase 2 — Day 0 structural refactor (added 2026-04-19)

Before Phase 2 Day 1 work begins:

1. **LLMClient refactor** (~4h)
   - Extract `src/llm/client.ts` interface: `generate(prompt, opts): Promise<AgentDecision>`.
   - Implement `OllamaProvider` (wraps current client) and `OpenRouterProvider` (OpenAI-compatible).
   - `LLM_PROVIDER` env switch in `src/index.ts`.
   - Boost-model split: orchestrator picks provider per persona via a `complexity` field on `AgentPersona`.
2. **Sim-worker split** (~6h)
   - New `src/api/server.ts` (REST + WS). Today's `src/index.ts` becomes `src/worker/main.ts`.
   - Filesystem IPC module: `src/ipc/command-reader.ts`, `src/ipc/event-writer.ts`.
   - Run id = UUID; `runs/<sim_id>/` per run.
3. **Memory interface** (~2h)
   - `src/agents/memory.ts` — `MemoryStore` interface (get recent, write action, get similar).
   - SQLite implementation first. Zep/mem0 stub file with TODO.
4. **Dockerfile stubs** (~2h)
   - `sim-engine/Dockerfile` + root `docker-compose.yml` that at least builds and runs the worker against a seeded LUNA scenario without the frontend.

Total: ~14h / 2 days. Buys us clean footing for the rest of Phase 2.

---

## Phase Plan

### Phase 1 — Foundation (Week 1)
**Goal: LUNA backtest reproduces death spiral**

**Days 1-2: Anchor Programs**
- Token mint with parameterizable supply/vesting
- Basic constant product AMM (x*y=k, configurable fees)
- Deploy + test on devnet
- Write TypeScript SDK wrapper for all program instructions

**Days 3-4: Simulation Engine Core**
- Tick controller (20s ticks for dev)
- StateManager: read price, balances, staking ratio via Helius
- AgentOrchestrator: 3 agents first (whale, yield farmer, retail degen)
- LLM integration: Ollama + Qwen3 8B, prompt → JSON action → execute tx
- SQLite: agent memory, tick history

**Day 5: LUNA Backtest**
- Feed exact LUNA/UST parameters:
  - Algorithmic stablecoin mint/burn mechanism
  - Anchor Protocol-style 19.45% APY staking
  - LFG reserve depletion model
- Run 50 ticks with 3 agents
- Verify: death spiral occurs, price → 0, staking drain visible

**Deliverable**: LUNA sim runs, death spiral visible, terminal output shows agent reasoning. Record 2-min video. This is the hero demo artifact.

**Days 6-7: Staking + Governance Programs**
- Staking program (lock, APY, cooldown)
- Governance program (propose, vote, execute)
- Expand to 8 agents

---

### Phase 2 — Full Sim + UI (Week 2) ✅ DONE (2026-04-28)
**Goal: All 20 agents running, live dashboard looks stunning**

**Days 1-2: Full Agent Roster** ✅
- [x] Implement all 20 agent personas with distinct system prompts ([sim-engine/src/agents/personas.ts](../sim-engine/src/agents/personas.ts))
- [x] Batch parallelism via `LLMClient.generateBatch` + primary/boost router ([sim-engine/src/llm/routing-client.ts](../sim-engine/src/llm/routing-client.ts))
- [x] Agent memory (SQLite per-agent + InMemoryStore) ([sim-engine/src/agents/memory.ts](../sim-engine/src/agents/memory.ts))
- [x] Inter-agent observation w/ visibility rules (INSIDER, ANALYST delays) ([sim-engine/src/agents/visibility.ts](../sim-engine/src/agents/visibility.ts))
- [x] Coordinated-attack detection (`coordinationEdges` in state) ([sim-engine/src/metrics/coordination.ts](../sim-engine/src/metrics/coordination.ts))
- [x] On-chain staking + governance wired via `ChainExecutor` ([sim-engine/src/chain/action-executor.ts](../sim-engine/src/chain/action-executor.ts))
- [x] LLM-drafted scenario generator (`POST /api/scenarios/draft`) ([sim-engine/src/scenarios/generator.ts](../sim-engine/src/scenarios/generator.ts))

**Days 3-4: Frontend — Agent Graph** ✅
- [x] D3 force-directed graph w/ pan + zoom + node-drag ([frontend/components/sim/AgentGraph.tsx](../frontend/components/sim/AgentGraph.tsx))
- [x] 20 nodes, color-coded by persona type
- [x] Animated edges on tx (red=sell/unstake, green=buy/stake, purple=governance), fade over 3 ticks
- [x] Node size = holdings (dynamic from `topHolders`)
- [x] Click node → floating NodeDetails card (reasoning log, recent actions, type pill)
- [x] **Light** MiroFish aesthetic (white bg, dotted canvas, mono labels)
- [x] Graph header: Refresh / Edge Labels toggle / Fullscreen ([frontend/components/sim/GraphHeader.tsx](../frontend/components/sim/GraphHeader.tsx))

**Days 5-6: Frontend — Metrics Dashboard** ✅
- [x] Real-time price chart (Recharts + WS-driven series) ([frontend/components/sim/PriceChart.tsx](../frontend/components/sim/PriceChart.tsx))
- [x] Gini coefficient over time w/ 0.6/0.7 threshold lines ([frontend/components/sim/GiniChart.tsx](../frontend/components/sim/GiniChart.tsx))
- [x] Staking ratio % + APY readout ([frontend/components/sim/StakingChart.tsx](../frontend/components/sim/StakingChart.tsx))
- [x] Top-holders donut + concentration % ([frontend/components/sim/TopHolders.tsx](../frontend/components/sim/TopHolders.tsx))
- [x] Live action feed, color-coded by agent type, click to inspect ([frontend/components/sim/AgentFeed.tsx](../frontend/components/sim/AgentFeed.tsx))
- [x] Threat indicator: STABLE → WATCH → ELEVATED → CRITICAL → DEATH SPIRAL ([frontend/components/sim/ThreatIndicator.tsx](../frontend/components/sim/ThreatIndicator.tsx))
- [x] Black bottom-strip SYSTEM DASHBOARD terminal (always visible) ([frontend/components/sim/SystemDashboard.tsx](../frontend/components/sim/SystemDashboard.tsx))
- [x] MiroFish-style numbered SectionCards on the right rail (`01 Live state`, `02 Price/Gini`, …) ([frontend/components/sim/SectionCard.tsx](../frontend/components/sim/SectionCard.tsx))

**Day 7: WebSocket Integration** ✅
- [x] Bun WebSocket server broadcasts NDJSON events per tick (replays history on connect) ([sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts))
- [x] Next.js client consumes via `useSimulation` reducer hook ([frontend/hooks/useSimulation.ts](../frontend/hooks/useSimulation.ts))
- [x] Top-nav with `Graph / Split / Workbench` view tabs + Step progress + ← back button ([frontend/components/TopNav.tsx](../frontend/components/TopNav.tsx))
- [x] Pause / resume / abort controls wired to `/api/sim/:id/{cmd}` ([frontend/components/sim/SimControls.tsx](../frontend/components/sim/SimControls.tsx))
- [x] End-to-end smoke: 20-agent LUNA scenario completes through WS, dashboard renders 200 with all sections

**Deliverable**: Full 20-agent sim running live. Dashboard ships. Demo-ready against `LLM_PROVIDER=mock` and Ollama (Qwen3 8B local). 36/36 sim-engine tests pass · `bunx tsc --noEmit` + `bunx next build` clean. **Outstanding for Phase 3**: 3-min Loom demo + on-chain run on Solana devnet/testnet (engine path exists; actual deploy + Loom slip into Phase 3 polish).

---

### Phase 3 — Polish + Whitepaper UX + Report (Week 3)
**Goal: Production-ready, whitepaper upload works, report is impressive**

**Days 1-2: Whitepaper Extraction UX**
- PDF upload component (react-dropzone)
- Claude API extraction prompt (SimulationConfig JSON output)
- Form pre-fill from extracted params
- Edit/override UI before deploying
- Validation: catch missing params, show defaults
- Test with: LUNA whitepaper, Jito whitepaper, a custom doc

**Days 3-4: Post-Sim Report Generation**
- Collect all tick data, agent actions, metrics history
- Single Claude API call with full simulation transcript
- Report sections:
  - Executive Summary (resilience score 0-100)
  - Failure Modes Detected (with tick timestamps)
  - Most Dangerous Agents (who caused the most damage)
  - Attack Vector Analysis (how each attack unfolded)
  - Recommendations (specific param changes to improve resilience)
  - Comparison to Historical Collapses (LUNA/CRV similarity score)
- MiroFish-style rendered report in right panel
- PDF download + shareable link

**Days 5-6: CRV Stress Test + Second Backtest**
- Implement CRV/Curve veToken model parameters
- Run sim: show WHY it survived (voting escrow = long-term alignment)
- Show remaining vulnerabilities (bribing market)
- Two validated backtests = strong credibility signal

**Day 7: End-to-End Polish**
- Full flow: upload whitepaper → extract → deploy → simulate → report
- Error handling, loading states, edge cases
- README + demo video (Loom, 3 min)
- Deploy to Railway

**Deliverable**: Complete product. Works end-to-end. Two validated backtests. Shareable reports.

---

### Phase 4 — Traction (Week 4)
**Goal: 5-10 LOIs, 10-20 GitHub stars, submission ready**

**Traction Strategy**

**GitHub**
- Open-source the full repo
- README with LUNA backtest GIF, architecture diagram, quick-start
- Publish the LUNA backtest as a standalone blog post (Mirror/Paragraph)
- Tweet thread: "We fed our simulator LUNA's tokenomics. Here's what happened." + video
- Target: 10-20 stars from Solana dev community

**Hackathon-Internal LOIs**
- Message every team building a token at Frontier: "Free stress test on your tokenomics, 30 min, we publish the report"
- Each free run = case study = their team shares it = more visibility
- Target: 5-10 teams respond, 3-5 published reports

**Outreach**
- AVKI (tokenized CRE on Solana, no AI layer) — offer free stress test of their token structure
- 2-3 smaller Solana DeFi protocols pre-launch (find via Colosseum pipeline / Superteam)
- Superteam Discord: post the LUNA backtest result, ask for feedback
- Solana AI Discord: post the agent architecture, discuss

**Colosseum Submission**
- Demo video: 3 min, shows full flow (whitepaper upload → deploy → 20 agents live → death spiral → report)
- Pitch video: founder story, problem, why Solana, traction evidence
- GitHub repo: clean, documented, MIT license
- Answer traction questions: X LOIs, Y free stress tests run, Z GitHub stars

---

## Metrics to Track During Simulation

| Metric | How Computed | Why It Matters |
|---|---|---|
| Token Price | AMM reserves ratio | Core health signal |
| Gini Coefficient | Lorenz curve of all wallet balances | Wealth centralization |
| Staking Ratio | staked / total supply | Unsustainable APY detection |
| Governance Nakamoto | Min wallets to reach quorum | Governance capture risk |
| Sell Pressure Index | Sell volume / buy volume per tick | Dump detection |
| Yield Sustainability | APY emissions / fee revenue | Death spiral precursor |
| Agent Coordination Score | Co-occurring large trades | Whale coordination detection |
| Liquidity Depth | AMM pool depth at ±10% | Slippage/manipulation risk |

---

## LUNA Backtest Parameters

```typescript
const LUNA_UST_CONFIG: SimulationConfig = {
  token: {
    totalSupply: 1_000_000_000,
    decimals: 6,
    allocations: [
      { name: "LFG Reserve", percent: 8, vestingMonths: 0 },  // immediately liquid
      { name: "Team", percent: 10, vestingMonths: 48 },
      { name: "Community", percent: 30, vestingMonths: 0 },
      { name: "Ecosystem", percent: 52, vestingMonths: 0 },
    ]
  },
  staking: {
    baseAPY: 19.45,  // Anchor Protocol rate
    maxAPY: 19.45,   // fixed (the design flaw)
    lockPeriodTicks: 0,  // no lock (the other flaw)
    unstakePenaltyPercent: 0,
  },
  amm: {
    initialLiquidity: 100_000_000,
    initialPrice: 85,  // ~peak LUNA price
    feeTier: 0.3,
    binStep: 10,
  },
  governance: {
    proposalThresholdPercent: 0.1,
    quorumPercent: 10,
    votingPeriodTicks: 5,
    timelockTicks: 0,
  }
}
```

**Expected sim outcome**: Yield farmers notice APY unsustainability → begin unstaking → sell pressure → price drops → more panic → staking ratio drops → APY becomes even less sustainable → death spiral in ~30-50 ticks.

---

## Competitive Differentiation

| | Gauntlet | TokenLab | Cenit Finance | **Tokenomics War Game** |
|---|---|---|---|---|
| LLM agents | ✗ | ✗ | ✗ | ✅ |
| On-chain execution | ✓ | ✗ | ✗ | ✅ |
| Adversarial framing | ✓ | partial | ✗ | ✅ |
| Historical backtest | ✗ | ✗ | ✗ | ✅ |
| Self-serve | ✗ | DIY code | ✓ | ✅ |
| Whitepaper upload | ✗ | ✗ | ✗ | ✅ |
| Solana-native | ✗ | ✗ | ✗ | ✅ |
| Price | $50K+ | free/DIY | free | $500-2K |

---

## Post-Hackathon Business Model

**Tier 1 — Self-Serve** ($500-2K/run)
- Upload whitepaper → standard 20-agent roster → automated report
- Target: every Solana token launch (500+/year)

**Tier 2 — Custom Engagement** ($5K-25K)
- Custom agent personas for specific attack scenarios
- Hand over your actual Anchor programs, we deploy unchanged
- Detailed remediation recommendations

**Tier 3 — Tokenomics CI** ($1K-5K/month)
- Post-launch continuous monitoring
- Re-run simulations on every governance proposal or parameter change
- Alerts when emerging attack vectors detected
- Integration with Anchor program upgrade workflow

**Long-term moat**: The simulation dataset. Every run teaches the agents better attack strategies. Over time, the agent personas become the most sophisticated tokenomics adversarial model in existence — trained on every collapse pattern seen.

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Anchor complexity (first time) | Start with simplified versions, expand. Constant product AMM is well-documented. Use anchor-by-example as reference. |
| Qwen3 8B reasoning quality | Test in week 1. If shallow, lean into "natural language scenario authoring" as differentiator. Claude API as fallback for complex agents. |
| 20 agents too slow | Reduce to 12 for demo if needed. Parallelism helps but LLM latency is the bottleneck. |
| LUNA backtest doesn't reproduce | Debug agent incentive alignment. The death spiral is deterministic given the parameters — if agents are rational, it should emerge. |
| Traction hard to get | The free stress-test offer to hackathon teams is the unlock. Literally walk up to teams at the event. |

---

## File Structure

```
tokenomics-war-game/
├── programs/                    # Anchor programs (Rust) — Phase 1 done
│   ├── token-mint/
│   ├── amm-dex/
│   ├── staking/
│   └── governance/
├── program-tests/               # LiteSVM Rust test harness — Phase 1 done
├── sim-engine/                  # Bun/TypeScript simulation
│   ├── src/
│   │   ├── api/                 # [Phase 2] REST + WebSocket server (long-lived)
│   │   │   ├── server.ts        # Bun HTTP + WS, spawns SimWorker processes
│   │   │   └── routes.ts        # POST /sim, POST /sim/:id/{pause,resume,abort}
│   │   ├── worker/              # [Phase 2] SimWorker child process
│   │   │   └── main.ts          # Replaces today's src/index.ts
│   │   ├── ipc/                 # [Phase 2] filesystem IPC (MiroFish-style)
│   │   │   ├── command-reader.ts
│   │   │   └── event-writer.ts
│   │   ├── tick/                # TickController, StateManager
│   │   ├── agents/
│   │   │   ├── orchestrator.ts
│   │   │   ├── personas.ts
│   │   │   └── memory.ts        # [Phase 2] MemoryStore interface (SQLite impl)
│   │   ├── llm/                 # [Phase 2 refactor] provider-agnostic
│   │   │   ├── client.ts        # LLMClient interface
│   │   │   ├── ollama-provider.ts
│   │   │   ├── openrouter-provider.ts
│   │   │   ├── mock-provider.ts # for tests
│   │   │   └── prompt-builder.ts
│   │   ├── chain/               # Anchor SDK wrappers, tx executor
│   │   ├── metrics/             # Gini, concentration, threat detection
│   │   ├── report/              # Claude API report generator
│   │   └── db/                  # SQLite per-run
│   ├── scenarios/
│   │   ├── luna-ust.ts          # done
│   │   ├── crv-curve.ts         # Phase 3
│   │   └── verify-luna.ts       # done
│   ├── scripts/
│   │   ├── deploy-programs.ts
│   │   ├── fund-agents.ts
│   │   └── extract-params.ts    # Phase 3 whitepaper extraction
│   └── Dockerfile               # [Phase 3] Bun runtime image
├── frontend/                    # Next.js 15 — Phase 2
│   ├── app/
│   │   ├── page.tsx             # Setup / whitepaper upload
│   │   ├── simulate/[id]/       # Live sim dashboard
│   │   └── report/[id]/         # Post-sim report
│   ├── components/
│   │   ├── AgentGraph.tsx       # D3 force graph
│   │   ├── PriceChart.tsx       # Recharts
│   │   ├── GiniChart.tsx
│   │   ├── AgentFeed.tsx        # Scrolling action log
│   │   ├── ThreatIndicator.tsx
│   │   ├── SimConsole.tsx       # Terminal-style log
│   │   └── ReportPanel.tsx      # MiroFish-style report
│   ├── hooks/
│   │   └── useSimulation.ts     # WebSocket state hook
│   └── Dockerfile               # [Phase 3] Next.js standalone image
├── runs/                        # [Phase 2] per-sim IPC + artifacts (gitignored)
│   └── <sim_id>/
│       ├── commands/            # API → worker
│       ├── events/              # worker → API (NDJSON)
│       ├── sim.sqlite
│       └── report.pdf
├── docker-compose.yml           # [Phase 3] sim-engine + frontend + optional ollama
├── docker-compose.dev.yml       # [Phase 3] dev overlay with hot reload
├── .env.example                 # [Phase 2] every env var documented
├── LICENSE                      # [Phase 3] MIT, for open-source release
├── CONTRIBUTING.md              # [Phase 3] add-a-persona / add-a-scenario recipes
└── README.md
```

---

## Success Metrics (Submission Day)

- [ ] LUNA death spiral reproduced and recorded
- [ ] CRV stress test shows resilience + remaining vulns
- [ ] 20 agents running live with visible reasoning
- [ ] Whitepaper upload → extract → deploy → sim works end-to-end
- [ ] Live dashboard: agent graph + price chart + Gini + action feed
- [ ] Post-sim report with resilience score + recommendations
- [ ] 5+ LOIs from protocol teams / hackathon participants
- [ ] 10+ GitHub stars
- [ ] 3-min demo video
- [ ] Deployed and accessible public URL