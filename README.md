# SIMWARS

> Adversarial LLM-agent stress tests for token economies. BYOK, runs on Solana devnet.

**Live:** [simwars.xyz](https://simwars.xyz) · [demos](https://simwars.xyz/demos) · [about](https://simwars.xyz/about)

## What it is

A swarm of LLM-driven agents (whales, retail degens, governance attackers, MEV bots, sybil rings, treasuries) interact with a token economy each tick. Every agent receives the live state (price, supply, staking ratio, governance proposals, on-chain balances) and decides what to do. The platform observes emergent behavior and produces a post-sim resilience report.

Two baked demos ship in the repo:
- **LUNA-UST**: Anchor's 19.45% APY + algorithmic stablecoin + zero lock reproduces the May 2022 death spiral (F grade).
- **Jupiter (JUP)**: DEX aggregator with the Litterbox Trust buyback absorbing Jupuary airdrop dump pressure (A grade).

## Scale + cost

- **Up to 5000 agents per simulation** (`SIM_MAX_AGENTS=5000` default, raise via env).
- **Prompt caching enabled end-to-end** via OpenRouter `cache_control: ephemeral`. The system prompt + cacheable persona zones get one breakpoint at the boundary so a 100-agent / 200-tick run reuses the same cached prefix across 20,000 LLM calls. Cache-hit ratio sits around 17-25% in practice; full token usage (prompt, completion, cached, cost USD) is logged per tick.
- Three-tier model routing (`fast`, `standard`, `reasoning`) routes cheap reactive personas to a Haiku-class model and coordinated attackers to the primary tier.

## Inspired by

- **[666ghj/MiroFish](https://github.com/666ghj/MiroFish)**: multi-agent simulation patterns, persona prompt structure.
- **[camel-ai/oasis](https://github.com/camel-ai/oasis)**: large-scale agent activation policy (only a fraction of agents act per tick to model real-market participation).

## Quick start

```bash
git clone https://github.com/narasim-teja/sim-wars.git
cd sim-wars

# Backend (Bun)
cd sim-engine && bun install
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > .env
bun run api                         # :8787

# Frontend (Next.js)
cd ../frontend && bun install
bun run dev                         # :3000

# Or a single LUNA backtest from the CLI:
cd sim-engine && bun luna           # ~$0.015 OpenRouter spend
```

## Architecture

```
                  https://simwars.xyz
                          │
                  Route 53 + ACM
                          │
                AWS App Runner (us-east-1)
                          │
                Caddy :8080  (reverse proxy)
                ┌─────────┴─────────┐
            /api/*               /*
                │                  │
        Bun :8787              Next.js :3000
        sim-engine API         prod server
                │
        spawned worker per active sim
                │
        runs/<simId>/  ·  runs-demo/<simId>/
```

| Layer | Tech |
|---|---|
| Frontend | Next.js 16, React 19, Recharts, base-ui |
| Backend | Bun + TypeScript, one worker subprocess per sim, NDJSON event log + SQLite |
| Realtime | Server-Sent Events (App Runner's Envoy edge blocks WebSockets, see [server.ts](sim-engine/src/api/server.ts)) |
| LLM | OpenRouter (BYOK), three-tier routing (`fast` / `standard` / `reasoning`), Anthropic prompt cache |
| On-chain | Anchor 1.0 + Solana web3.js (programs in [programs/](programs/), disabled in prod) |
| Container | Caddy + Bun + Node, single image, `wait -n` propagates crashes |
| Infra | App Runner, ECR, Route 53, ACM (idempotent shell scripts in [infra/aws/](infra/aws/)) |

## Repo layout

```
sim-engine/        Bun TypeScript: agent loop, LLM client, on-chain executor
  src/             API server, worker, agents, llm, chain, ipc, report
  scenarios/       luna.ts, jupiter.ts, swarm-100.ts
  runs-demo/       baked NDJSON event streams (one dir per recorded demo)
  scripts/         CLI entry points (record-demo, dump-scenario-json, ...)
frontend/          Next.js: landing, /demos, /simulate/[id], /report/[id], /about
programs/          Anchor programs: token mint, AMM, staking, governance
infra/             Dockerfile, Caddyfile, entrypoint.sh, AWS shell scripts
docs/              Whitepapers + reference material (LUNA.pdf, JUP.md)
```

## Configuration

Production-relevant env vars:

| Env | Default | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | unset | Server-side fallback. Production runs require BYOK and never holds a key. |
| `OPENROUTER_AGENT_PRESET` | unset | OpenRouter routing preset for the standard tier. |
| `OPENROUTER_BOOST_PRESET` / `_REASONING_PRESET` / `_REPORT_PRESET` | unset | Per-tier model overrides. |
| `SIM_REQUIRE_BYOK` | `0` (prod: `1`) | Reject `POST /api/sim` without `byokOpenRouterKey`. |
| `SIM_DISABLE_ONCHAIN` | `0` (prod: `1`) | Reject `onChain: true` requests with 400. |
| `SIM_API_PORT` | `8787` | Bun API port. Do not use `PORT`, App Runner reserves it. |
| `SIM_ACTIVATION_POLICY` | `all` | `sampled` cuts swarm-scale cost by ~40%. |
| `SIM_MAX_AGENTS` | `5000` | Hard ceiling enforced in the API. |

## Deploy

```bash
# Build linux/amd64 image, push to ECR, deploy to App Runner
AWS_ACCOUNT_ID=... bash infra/aws/02-build-push.sh
AWS_ACCOUNT_ID=... bash infra/aws/03-deploy.sh
```

Anchor IDLs must be present at `target/idl/*.json` before building. Run `anchor build --ignore-keys` first.
