# Phase 2 — Detailed Implementation Guide

## Session Status (as of 2026-04-19)

> **Day 0 structural refactor complete.** Ready for Days 1-7 (full roster + frontend). See [phase1.md](phase1.md) for everything shipped in Phase 1 and [plan.md](plan.md#architectural-review--post-phase-1-2026-04-19) for the architectural review that justifies the shape below.

### What's Done — Day 0 Structural Refactor

Before Day 1 work starts, these got refactored so we don't rewrite mid-sprint:

**LLM provider abstraction** (MiroFish-style primary + boost)
- [src/llm/types.ts](../sim-engine/src/llm/types.ts) — `LLMClient` interface, `AgentComplexity = "fast" | "standard" | "reasoning"`.
- [src/llm/parse.ts](../sim-engine/src/llm/parse.ts) — shared 4-strategy JSON parser (direct → fenced → embedded → hold-fallback).
- [src/llm/providers/ollama-provider.ts](../sim-engine/src/llm/providers/ollama-provider.ts) — local Qwen3 via `/api/generate`.
- [src/llm/providers/openrouter-provider.ts](../sim-engine/src/llm/providers/openrouter-provider.ts) — OpenAI-compatible chat completions. Works against OpenRouter, OpenAI, Groq, Together, vLLM — anything OpenAI-schema.
- [src/llm/providers/mock-provider.ts](../sim-engine/src/llm/providers/mock-provider.ts) — deterministic in-process for tests.
- [src/llm/routing-client.ts](../sim-engine/src/llm/routing-client.ts) — wraps primary + boost; dispatches `fast` personas to boost, rest to primary.
- [src/llm/factory.ts](../sim-engine/src/llm/factory.ts) — reads `LLM_PROVIDER` + `LLM_BOOST_*` env → concrete `LLMClient`.
- Old `src/llm/ollama-client.ts` **deleted** (superseded).

**Per-persona complexity routing**
- [src/types.ts](../sim-engine/src/types.ts) — `AgentPersona.complexity?: "fast" | "standard" | "reasoning"`.
- [src/agents/personas.ts](../sim-engine/src/agents/personas.ts) — every existing persona tagged: WHALE/GOV → `reasoning`, DEGEN/FARMER → `fast`, HOLDER → `standard`.
- [src/agents/orchestrator.ts](../sim-engine/src/agents/orchestrator.ts) — accepts any `LLMClient`; batches now carry `complexity` so the router can split.

**MemoryStore interface**
- [src/agents/memory.ts](../sim-engine/src/agents/memory.ts) — `MemoryStore` interface + `InMemoryStore` (Phase 1 behavior) + `SqliteMemoryStore` (reads from `agent_actions`, hot in-mem cache). Phase 3+ can plug Zep/mem0 behind the same shape.

**Filesystem IPC (MiroFish pattern)**
- [src/ipc/paths.ts](../sim-engine/src/ipc/paths.ts) — every run owns `runs/<sim_id>/{commands/,events.ndjson,scenario.json,sim.sqlite,status.json}`.
- [src/ipc/event-writer.ts](../sim-engine/src/ipc/event-writer.ts) — append-only NDJSON events + status-file updates.
- [src/ipc/command-reader.ts](../sim-engine/src/ipc/command-reader.ts) — directory-polling reader for `pause`/`resume`/`abort`. `writeCommand(dir, cmd)` helper for the API side.

**Worker split (child-process isolation)**
- [src/worker/simulation.ts](../sim-engine/src/worker/simulation.ts) — pure tick loop, injectable callbacks, no `console.log`. Called from both CLI and worker.
- [src/worker/main.ts](../sim-engine/src/worker/main.ts) — the child-process entrypoint. Reads `runs/<sim_id>/scenario.json`, emits NDJSON events, polls commands between ticks.
- [src/index.ts](../sim-engine/src/index.ts) — now a thin CLI around `runSimulation` (Phase 1 dev UX preserved).

**API / WebSocket server**
- [src/api/server.ts](../sim-engine/src/api/server.ts) — Bun.serve. Endpoints:
  - `POST /api/sim` — create run (returns `{ simId }`, spawns worker subprocess)
  - `GET  /api/sim` — list runs
  - `GET  /api/sim/:id` — status snapshot
  - `POST /api/sim/:id/{pause,resume,abort}` — control
  - `WS   /ws/sim/:id` — tails `events.ndjson`, replays history on connect, streams new events
  - `GET  /health`

**Docker**
- [sim-engine/Dockerfile](../sim-engine/Dockerfile) — `oven/bun:1.3-alpine`, CMD runs API server on 8787.
- [sim-engine/.dockerignore](../sim-engine/.dockerignore)
- [docker-compose.yml](../docker-compose.yml) — `sim-engine` service + optional `ollama` service via `--profile ollama`.
- [.env.example](../.env.example) — every env var the project reads.

**Tests (all passing: 10/10)**
- [src/llm/parse.test.ts](../sim-engine/src/llm/parse.test.ts)
- [src/llm/routing-client.test.ts](../sim-engine/src/llm/routing-client.test.ts)
- [src/worker/simulation.test.ts](../sim-engine/src/worker/simulation.test.ts)
- [src/api/server.integration.test.ts](../sim-engine/src/api/server.integration.test.ts) — spawns the server subprocess, POSTs a tiny sim, connects WS, verifies events stream, status reaches `completed`.

---

## What's Left in Phase 2

| Day | Deliverable | Touches |
|---|---|---|
| 1 | 12 new personas → 20-agent roster | `src/agents/personas.ts` |
| 1 | On-chain staking + governance wiring in sim engine | `src/chain/sdk.ts`, `src/chain/action-executor.ts`, `src/agents/orchestrator.ts` |
| 2 | Inter-agent observation + coordinated-attack detection | `src/agents/orchestrator.ts`, new `src/metrics/coordination.ts` |
| 2 | LLM-drafted sim config (MiroFish pattern) | new `src/scenarios/generator.ts` |
| 3-4 | Next.js 15 scaffold + live agent force graph | `frontend/` |
| 5 | Recharts metrics dashboard (price, Gini, staking, governance pie) | `frontend/` |
| 6 | Action feed + threat indicator + sim console | `frontend/` |
| 7 | End-to-end polish with 20 live agents, Loom video | all |

---

## Inspiration references

### MiroFish — [github.com/666ghj/MiroFish](https://github.com/666ghj/MiroFish)

Study these files in their repo before starting day work:

| MiroFish file | Why it's worth reading |
|---|---|
| `backend/app/services/simulation_manager.py` | Their top-level sim driver. Dual-platform (Twitter + Reddit) orchestration; worth mirroring the separation-of-concerns for our "phases" (trading / governance / liquidity). |
| `backend/app/services/simulation_runner.py` | Child-process runner + `atexit` cleanup. We already mirror this in [src/worker/main.ts](../sim-engine/src/worker/main.ts). |
| `backend/app/services/simulation_ipc.py` | Filesystem IPC prior art. We follow this shape in [src/ipc/](../sim-engine/src/ipc/). Read it if you need to extend the command vocabulary. |
| `backend/app/services/oasis_profile_generator.py` | LLM-generated persona authoring. Direct inspo for Day 2's `scenarios/generator.ts` — give an LLM a prompt, get back 20 personas as JSON. |
| `backend/app/services/simulation_config_generator.py` | LLM-generated sim parameters from a plain-English goal. Inspo for the same day. |
| `backend/app/services/zep_graph_memory_updater.py` | How they write per-agent memory to Zep after each round. Reference for Phase 3 memory upgrade. |
| `backend/app/api/simulation.py` | The `INTERVIEW_PROMPT_PREFIX` hack — a short prompt prefix that forces text-only (no tool-calling) replies. Steal this pattern when we let the UI "interview" an agent mid-sim. |
| `frontend/src/views/` | Vue 3 force-graph + report UI. Translate to React/Next.js + D3 for us. |

**Patterns already adopted** (Day 0 refactor):
- Filesystem IPC between API and sim worker.
- OpenAI-compatible LLM adapter + boost-model split.
- LLM-drafted sim config (reserved for Day 2).
- Docker single-container demo layout (adapted to compose).

**Patterns we explicitly skip**:
- Python / Flask — we stay on Bun/TS; every Solana SDK we need is TS-native.
- Zep Cloud as default memory — deferred; the `MemoryStore` interface is ready for it.
- REST polling frontend — we use WebSockets because our tick cadence is fast.

### OASIS (CAMEL-AI) — [github.com/camel-ai/oasis](https://github.com/camel-ai/oasis)

The swarm-sim engine MiroFish wraps. Even though we're *not* adopting OASIS (it's Python-native; our chain execution is TS-native), the paper and repo are gold for:

- **Agent action envelopes** — how they structure the `allowed_actions` list per platform. Look at their `twitter_actions` / `reddit_actions` enums. We want the same for `trading_actions` (buy/sell/stake) vs `governance_actions` (propose/vote) vs `liquidity_actions` (add/remove-lp) in Day 2.
- **Round-based progression** — OASIS advances N simulated hours per round. Our ticks are the same abstraction. Their round-summary struct is worth mirroring in our [src/ipc/event-writer.ts](../sim-engine/src/ipc/event-writer.ts) event types.
- **Million-agent scaling notes** — informs how we might eventually push past 20. Not Phase 2 scope, but shapes design.

### Memory (Phase 3 deferred, behind `MemoryStore`)

- **Zep Cloud** — [getzep.com](https://www.getzep.com/) — graph-RAG memory, temporal facts, per-user sessions. Paid SaaS. Good when we want cross-run agent personality persistence.
- **mem0** — [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) — open-source alternative. Self-hostable. Good first fit for Phase 3 if we want to stay open-source.

---

## Days 1-2 — Full Agent Roster + Sim-Engine Chain Wiring

### Goal
20 agents running with distinct personas, staking and governance now go through Anchor programs (not in-memory), inter-agent observation works, coordinated attacks are detectable.

### 1. Add 12 more personas ([src/agents/personas.ts](../sim-engine/src/agents/personas.ts))

Per `plan.md`'s Agent Roster section, we currently have 8. Still to add:

| New ID | Type | Complexity | Rough notes |
|---|---|---|---|
| `GOV_02` | governance_attacker | reasoning | Colludes with `GOV_01` — mirrors votes. |
| `SYBIL_01` | sybil | standard | Controls 5 sub-wallets (for now, keep them virtual in `InMemoryStore` observation graph). |
| `MEV_01` | mev_bot | reasoning | Front-runs large buys, sandwich attacks — reads `sim.recentLargeTrades`. |
| `FARMER_03` | yield_farmer | fast | Third farmer — makes the cascade visible. |
| `DEGEN_02`, `DEGEN_03` | retail_degen | fast | Amplify panic cascades. |
| `ARB_01` | arbitrageur | standard | Rational, reacts to `tokenPrice` vs `pegPrice` gap. |
| `TREASURY_01` | treasury | standard | Buybacks on dips. Protocol-side stabilizer. |
| `LP_01` | lp_provider | standard | Add/remove liquidity based on IL risk. |
| `ANALYST_01` | analyst | reasoning | Reads all actions, publishes "reports" → injects into observed actions. |
| `INSIDER_01` | insider | reasoning | Has advance knowledge of treasury actions (see Day 2). |
| `PANIC_01` | panic_seller | fast | Sells on any negative signal. |

Tag `complexity` on each. Keep numeric decision triggers explicit (same pattern as existing personas — see `WHALE_01.systemPrompt`).

Export a new `ALL_PHASE2_PERSONAS: AgentPersona[]` alongside `ALL_PHASE1_PERSONAS`. Update [scenarios/luna-ust.ts](../sim-engine/scenarios/luna-ust.ts) to switch to 20 agents via a `--full-roster` flag or a second scenario file.

### 2. On-chain staking + governance wiring

The Anchor programs already ship (19/19 tests green — see [phase1.md](phase1.md#whats-done)). Sim-engine needs to route staking/governance through them instead of `StateManager.stake/unstake`.

Touch points:

- [src/chain/sdk.ts](../sim-engine/src/chain/sdk.ts) — add `getStakingProgram()` and `getGovernanceProgram()` wrappers paralleling `getAmmDexProgram()`.
- [src/chain/action-executor.ts](../sim-engine/src/chain/action-executor.ts) — add `stake()`, `requestUnstake()`, `completeUnstake()`, `claimRewards()`, `createProposal()`, `castVote()` methods.
- [src/agents/orchestrator.ts](../sim-engine/src/agents/orchestrator.ts)'s `executeAction` switch — currently `vote_yes`/`vote_no`/`propose` fall through to `hold`. Wire them up when `this.chain && this.chain.hasAgent(...)`.
- Also: tick advance. Staking APY accrual is tick-denominated and gated by `staking::set_tick` (authority-gated, monotonic). Add a per-tick chain call in the worker to bump the on-chain tick counter — currently only in-memory.
- `StateManager.stake/unstake` stays as the in-mem fast path when `--on-chain` is *off* (dev loop).

### 3. Inter-agent observation

Already implemented at a basic level in orchestrator (`agent.observedActions`). Upgrade:

- Observations should carry **visibility rules**. `INSIDER_01` sees `TREASURY_01`'s pending action before it executes; `ANALYST_01` sees everyone's actions one tick late (like a published report); `SYBIL_01`'s sub-wallets share observations.
- Extract this into [src/agents/visibility.ts](../sim-engine/src/agents/visibility.ts) — `computeObservableActions(observerId, allActions, visibilityRules)`.
- Extend [src/agents/memory.ts](../sim-engine/src/agents/memory.ts)'s `recordObservation` to accept a `delay` (ticks) and `fidelity` (fraction of detail visible).

### 4. Coordinated-attack detection

New module: [src/metrics/coordination.ts](../sim-engine/src/metrics/coordination.ts).

- Co-occurrence score: for each pair of agents in a sliding window of 5 ticks, count co-occurring large actions (>1% of supply). High score → possible collusion.
- Feed into `SimulationState` as a new `coordinationEdges: { a: string; b: string; score: number }[]` field.
- Frontend uses this to draw dashed red edges between colluding nodes.

### 5. LLM-drafted sim config (MiroFish's `simulation_config_generator.py`)

New module: [src/scenarios/generator.ts](../sim-engine/src/scenarios/generator.ts).

Prompt: "Given the goal `${goal}`, return a `SimulationConfig` JSON with realistic defaults. Explain each choice in an adjacent `rationale` field."

Wire a new API route: `POST /api/scenarios/draft { goal: string } → { config, rationale }`. User edits, then `POST /api/sim` with the final config.

### 6. Tests to add

- [src/agents/visibility.test.ts](../sim-engine/src/agents/visibility.test.ts) — INSIDER sees treasury ahead of others.
- [src/metrics/coordination.test.ts](../sim-engine/src/metrics/coordination.test.ts) — two whales dumping same tick → high score.
- [src/chain/action-executor.test.ts](../sim-engine/src/chain/action-executor.test.ts) — staking/governance calls against a mocked `Program` (use [src/llm/providers/mock-provider.ts](../sim-engine/src/llm/providers/mock-provider.ts) as a template for the pattern).

---

## Days 3-4 — Frontend: Agent Force Graph

### Goal
Next.js 15 scaffold under `frontend/`, agent graph renders live from WebSocket events, looks like [MiroFish's demo](https://github.com/666ghj/MiroFish#readme).

### Scaffold

```bash
cd /Users/narasim/Code/work/sim-wars
bunx create-next-app@latest frontend --typescript --tailwind --app --no-src-dir --use-bun
cd frontend
bunx shadcn@latest init
bunx shadcn@latest add button card tabs dialog
bun add d3 recharts framer-motion
bun add -D @types/d3
```

### Routes

- `app/page.tsx` — setup screen: paste whitepaper / pick scenario / configure → `POST /api/sim` → redirect to `/simulate/[id]`.
- `app/simulate/[id]/page.tsx` — live dashboard (Days 3-6 all land here).
- `app/report/[id]/page.tsx` — post-sim report (Phase 3).

### WebSocket hook

`frontend/hooks/useSimulation.ts`:

```ts
export function useSimulation(simId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:8787/ws/sim/${simId}`);
    ws.onmessage = (ev) => dispatch(JSON.parse(ev.data) as WorkerEvent);
    return () => ws.close();
  }, [simId]);
  return state;
}
```

Event types are already defined in [src/ipc/event-writer.ts](../sim-engine/src/ipc/event-writer.ts) — export them from a shared `packages/shared/events.ts` or duplicate the types in the frontend (simpler for now). On WS open, the server replays the full history — the hook just folds events into state with a reducer.

### AgentGraph component

`frontend/components/AgentGraph.tsx`:

- D3 force simulation with `d3.forceManyBody`, `d3.forceCenter`, `d3.forceLink`.
- Nodes: one per agent. Color by `persona.type`. Size by `holdings.token + holdings.staked`.
- Edges: transient, one per large action this tick. Fade over 3 ticks via Framer Motion. Red = sell/unstake, green = buy/stake, purple = governance.
- Click → right-side drawer (shadcn `Sheet`) with the agent's last 10 actions + reasoning + wallet.
- When `coordinationEdges` arrive (Day 2), draw dashed red edges between colluding pairs.

MiroFish reference: `frontend/src/components/GraphView.vue` in their repo. We're rewriting, not porting, but the layout idea is identical.

### Threshold for "large action"

A trade is "large" for graph animation purposes if `|amount| > 0.5% of total supply` (for tokens) or `|amount| > $1M` (for USDC). Keep these configurable in a top-level `config.ts`.

---

## Days 5-6 — Metrics Dashboard + Action Feed + Threat Indicator

### Goal
Right pane populated with all of MiroFish's "Round Data" equivalent. Everything updates on each `tick:complete` event.

### Components to build

- `PriceChart.tsx` — Recharts line, reads `state.tokenPrice` + `state.priceHistory`. Dual-axis if stablecoin scenario (peg vs token price).
- `GiniChart.tsx` — Gini over time. Highlight threshold at 0.7 (HIGH CENTRALIZATION).
- `StakingRatio.tsx` — % staked of total supply, tick history, death-spiral warning when dropping rapidly.
- `GovernancePie.tsx` — voting power distribution — top 5 + "Rest". Red slice if any single wallet > 33%.
- `AgentFeed.tsx` — scrolling action log. One line per `agent:action` event. Color-coded by agent type. Pause-on-hover. MiroFish's action log is a direct reference.
- `ThreatIndicator.tsx` — green → yellow → red → DEATH SPIRAL. Gates:
  - Green: price stable, Gini < 0.6, reserve > 70%.
  - Yellow: price drop > 5%/tick OR Gini > 0.6 OR reserve < 70%.
  - Red: price drop > 20%/tick OR reserve < 30%.
  - DEATH SPIRAL: emitted when the worker sends `sim:death_spiral`.
- `SimConsole.tsx` — terminal-style pane, shows raw event log for debugging. MiroFish has a similar "system log" panel. Use `font-mono` + green-on-black for the vibe.

### Layout (shadcn)

```
<div class="grid grid-cols-[1fr_420px] h-screen bg-black text-white">
  <div class="relative"> <AgentGraph /> </div>
  <div class="flex flex-col border-l border-white/10">
    <Tabs defaultValue="metrics">
      <TabsList>
        <TabsTrigger value="metrics">Metrics</TabsTrigger>
        <TabsTrigger value="feed">Feed</TabsTrigger>
        <TabsTrigger value="console">Console</TabsTrigger>
      </TabsList>
      <TabsContent value="metrics"> ...charts... </TabsContent>
      <TabsContent value="feed"> <AgentFeed /> </TabsContent>
      <TabsContent value="console"> <SimConsole /> </TabsContent>
    </Tabs>
    <div class="p-4 border-t"> <ThreatIndicator /> </div>
  </div>
</div>
```

### Top nav

Step progress bar: `Configure → Deploy → Simulate → Report`. shadcn `Progress` or a custom set of pills. Badge next to it: `● RUNNING` / `● PAUSED` / `● DEATH SPIRAL`.

---

## Day 7 — Integration & Polish

- Run the 20-agent LUNA scenario end-to-end with the new dashboard.
- Tune tick interval so the UI feels alive (target 5-8s per tick in dev; faster when LLM responses land).
- Fix: stuttering graph, chart re-renders, WS reconnection on refresh.
- Edge cases: zero-action ticks, worker crash mid-run (API should flip status to `failed`, UI should show it), pause/resume.
- Record 3-minute Loom walking through: whitepaper upload (stub ok) → deploy → 20 agents live → death spiral → report placeholder.

---

## How to run what's built

### Sim engine — CLI mode (Phase 1 dev flow, unchanged)

```bash
cd sim-engine

# Local Ollama (current dev default)
ollama serve &
ollama pull qwen3:8b
bun run src/index.ts ../scenarios/luna-ust.ts

# OpenRouter (no Ollama required)
OPENROUTER_API_KEY=sk-or-... LLM_PROVIDER=openrouter LLM_MODEL=qwen/qwen3-8b \
  bun run src/index.ts ../scenarios/luna-ust.ts

# Mock LLM for CI / no-network testing
LLM_PROVIDER=mock bun run src/index.ts ../scenarios/luna-ust.ts
```

### Sim engine — API server

```bash
cd sim-engine
bun run src/api/server.ts
# listens on :8787
# POST /api/sim with { config, agents, tickConfig } → spawns worker, returns simId
# WS /ws/sim/:id → live event stream
```

### Docker

```bash
# Engine only (expects OpenRouter via .env)
docker compose up --build sim-engine

# Engine + local Ollama
docker compose --profile ollama up --build
```

### Tests

```bash
cd sim-engine
bun test                                           # 10 tests, all green
bun test src/api/server.integration.test.ts       # full API + WS + worker subprocess path
bunx tsc --noEmit                                  # typecheck
```

### Rust program tests (unchanged from Phase 1)

```bash
anchor build --ignore-keys
cargo test -p program-tests
# 19/19 tests pass
```

---

## Implementation notes & gotchas

1. **Do not bundle the sim engine with `bun build`.** `@solana/web3.js` breaks under Bun's bundler. Always `bun run src/...` (direct execution). Dockerfile follows this.
2. **Anchor 1.0 build command**: `anchor build --ignore-keys` (spurious transient-keypair check in 1.0). See [anchor-1.0-migration.md](anchor-1.0-migration.md).
3. **Worker scenario format is JSON, not TS.** The API serializes the TS scenario's `config`/`agents`/`tickConfig` to `runs/<sim_id>/scenario.json` before spawning the worker. Day 2's LLM-drafted sim config lands here naturally — it's already JSON.
4. **LLM provider env precedence**: `LLM_PROVIDER` (top-level) > provider-specific env. `LLM_BOOST_*` is entirely optional; if unset, the router short-circuits to primary. See [src/llm/factory.ts](../sim-engine/src/llm/factory.ts).
5. **Complexity tag is purely routing**. It does NOT change the prompt. If you want larger `max_tokens` for reasoning agents, extend `LLMBatchItem` with an `options` field and plumb it through [src/llm/routing-client.ts](../sim-engine/src/llm/routing-client.ts).
6. **Filesystem IPC caveat**: the worker polls the commands directory *between* ticks. Pause/resume/abort will not interrupt a tick in progress; they take effect once the current tick's LLM batch resolves. Acceptable given our tick cadence; revisit if we ever need mid-tick cancel.
7. **WebSocket replay on connect**: the server pushes the full event history when a client connects. For a 200-tick run × 20 agents × ~10 events/tick, that's ~40k lines — trivial. If we ever need to cap it, add an `?since=<tick>` query param.
8. **SQLite per-run**: each sim writes to `runs/<sim_id>/sim.sqlite`, independent DB files. The legacy shared `.local/sim-data.sqlite` is still used by the CLI entrypoint ([src/index.ts](../sim-engine/src/index.ts)) for Phase 1 continuity. Worker-driven runs do not touch it.
9. **CORS is wide-open (`*`)**. Fine for local dev; tighten before any public deploy.
10. **OrbStack users**: `docker` and `docker compose` work the same as Docker Desktop. Tested and confirmed — `docker build -t sim-wars/sim-engine:dev .` completes in ~3s on warm cache.

---

## Success criteria (end of Phase 2)

- [ ] 20 agents run live against deployed Anchor programs on localnet or devnet.
- [ ] Dashboard shows real-time graph + 4 charts + action feed + threat indicator, all synced to WS events.
- [ ] One-click start from the UI: configure → deploy → simulate.
- [ ] Pause/resume/abort work from the UI.
- [ ] LUNA backtest still reproduces death spiral with the 20-agent roster.
- [ ] `docker compose up` boots the engine with OpenRouter + mock LLM for demos without local Ollama.
- [ ] Typecheck + test suite green (15+ tests including integration).
- [ ] Loom demo video (3 min) recorded.
