# SIMWARS

> Adversarial LLM-agent stress tests for token economies. Open-source, BYOK, runs on Solana devnet.

**🌐 Live: https://simwars.xyz** &nbsp;·&nbsp; [Demos](https://simwars.xyz/demos) &nbsp;·&nbsp; [About](https://simwars.xyz/about)

---

## What it is

A swarm of LLM-driven agents (whales, retail degens, governance attackers, MEV bots, sybil rings, treasuries) autonomously interact with a token economy you describe — either a preset (LUNA-UST, Curve veCRV) or a config you draft from a whitepaper PDF. Each tick, every agent receives the current state (price, supply, staking ratio, governance proposals, on-chain balances) and decides what to do. The platform observes emergent behavior — death spirals, governance capture, sybil collusion, peg breaks — and ships a post-sim resilience report.

Validated against historical collapses: feed it LUNA's parameters and the agents reproduce the death spiral.

## Try it without signing up

1. Open https://simwars.xyz/demos
2. Click either pre-recorded card (Curve veCRV survives, Uniswap UNI survives — a real LUNA death-spiral demo is the next thing to record)
3. Watch the full run replay — token price, agent feed, governance traffic, post-sim report

To run a custom sim against your own protocol's tokenomics:
1. Get an OpenRouter key at https://openrouter.ai/keys
2. From https://simwars.xyz, paste the key (BYOK — never persisted server-side, see [docs/deploy-handoff.md](docs/deploy-handoff.md) §2.1)
3. Either pick a preset or upload a whitepaper PDF; the extractor drafts a config
4. Adjust agent count + tick budget; click Deploy & simulate

## Quick start (local dev)

```bash
# 1. Clone + install
git clone https://github.com/narasim-teja/sim-wars.git
cd sim-wars

# 2. Backend (Bun)
cd sim-engine && bun install
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > .env  # required for live runs
bun test                                         # 85/85 pass

# 3. Frontend (Next.js 16)
cd ../frontend && bun install

# 4. Run both, in two terminals
cd sim-engine && bun run api     # API + WebSocket on :8787
cd frontend  && bun run dev      # UI on :3000
```

Or run a single LUNA backtest from the CLI without the API server:
```bash
cd sim-engine && bun luna   # ~12 ticks, ~$0.015 OpenRouter spend, "Death spiral: YES"
```

## Deploy your own (AWS, ~$60/mo)

The whole thing fits in one Docker container (Caddy + Bun API + Next.js) and runs on AWS App Runner with a custom domain. Shell scripts in [`infra/aws/`](infra/aws/) bootstrap the deploy:

```bash
export AWS_ACCOUNT_ID=<your account>
export AWS_PROFILE=<your profile>          # default: dev
export DOMAIN=<your domain>                # default: simwars.xyz

bash infra/aws/01-bootstrap.sh   # R53 zone, ECR repo, IAM roles
# → paste the printed nameservers into your registrar
bash infra/aws/02-build-push.sh  # buildx --platform linux/amd64 → ECR
bash infra/aws/03-deploy.sh      # creates the App Runner service
bash infra/aws/04-domain.sh      # apex ALIAS + www CNAME + ACM cert validation
```

Full deployment notes live in [docs/deploy-handoff.md](docs/deploy-handoff.md), including the App Runner `PORT`-env gotcha, the apex-ALIAS-not-CNAME trick, and the BYOK redaction contract.

## Architecture

```
                  https://simwars.xyz
                          │
                  Route 53 hosted zone
                          │
                AWS App Runner (us-east-1)
                          │
                Caddy :8080  (reverse proxy)
                ┌─────────┴─────────┐
            /api/*               /*
            /ws/*           
                │                  │
        Bun :8787              Next.js :3000
        sim-engine API         prod server
                │
        spawned worker subprocesses
        per active simulation
                │
        runs/<simId>/ + runs-demo/<simId>/
```

| Layer | Tech | Notes |
|---|---|---|
| Frontend | Next.js 16, React 19, Recharts, base-ui | Live cost meter via WebSocket telemetry |
| Backend | Bun + TypeScript | One worker subprocess per active sim; NDJSON event log + SQLite per run |
| LLM | OpenRouter (BYOK) | Three-tier routing: fast / standard / reasoning. Prompt-cache aware. |
| On-chain | Anchor 1.0 + Solana web3.js | Token mint, AMM DEX, staking, governance — disabled in prod, enabled locally |
| Container | Caddy + Bun + Node + tini | Single image, three processes, `wait -n` propagates crashes |
| Infra | AWS App Runner, ECR, Route 53, ACM | Idempotent shell scripts in `infra/aws/` |

**LLM cost / latency at 100 agents × 5 ticks** (with `SIM_ACTIVATION_POLICY=sampled`):
- ~$0.04 / run, ~3s tick latency, ~11% cache hit rate, full LUNA fidelity preserved.
- See [docs/scaling-handoff.md](docs/scaling-handoff.md) for the empirical numbers and the reasoning behind every knob.

## Agent personas

Each persona has a hand-written system prompt + traits (risk tolerance, time horizon, capital, staking fraction). Templates expand into N clones with deterministic per-instance perturbations.

| Type | What they do |
|---|---|
| **Whale** | Accumulates, dumps strategically when conditions favor exit |
| **Retail degen** | FOMO buys, panic sells on 10%+ drawdowns |
| **Yield farmer** | Chases highest APY, exits when emissions thin |
| **Governance attacker** | Accumulates voting power, submits self-serving proposals |
| **MEV bot** | Front-runs large trades |
| **Sybil ring** | Operates 5–20 coordinated wallets |
| **Long-term holder** | Stakes and forgets, occasionally votes |
| **Arbitrageur** | Rational exploiter of price discrepancies |
| **Treasury** | Automated defender — buybacks, liquidity provision |
| **Insider** | Pre-launch knowledge, signals to allies |
| **Analyst** | Reads governance, reasons about systemic risk |
| **Panic seller** | Asymmetric loss aversion, contagion-prone |

12 archetypes total. Roster expander mixes them by preset (`luna`, `crv`, `balanced`, `stress`, `lockup_resilience`).

## Backtest validation

The LUNA-UST regression is the ground-truth fidelity test. Every change to the prompt builder, activation policy, or pipeline path must keep `bun luna` printing **"Death spiral: YES"** with the price collapsing >99% by tick 12.

| Scenario | Expected | Reality |
|---|---|---|
| LUNA-UST (Anchor 19.45% APY, algo-stable, $3B LFG) | Death spiral by ~tick 6–8 | ✓ reproduced consistently |
| Curve veCRV (4-year lock, modest APY, fee-funded) | Survives, S grade | ✓ replays as a demo |
| Uniswap UNI (60% community float, no peg) | Survives, A grade | ✓ replays as a demo |

## Solana-native (currently dev-only)

The on-chain path uses Anchor programs (token mint, AMM, staking, governance) deployed to a local `solana-test-validator` per-run. Production deployment **disables** this via `SIM_DISABLE_ONCHAIN=1` because per-sim full-deploy on devnet would torch faucet rate limits. The v2 plan is shared pre-deployed devnet programs that user sims call into:

- Pre-deploy program IDs once, pin in `infra/onchain/devnet-programs.json`
- Admin keypair in AWS Secrets Manager (small SOL balance for per-sim PDA rent)
- Helius RPC free tier
- Wallet-adapter on the frontend for users who want to sign their own actions

See [docs/deploy-handoff.md](docs/deploy-handoff.md) §6.1 for the full v2 sketch.

## Why this might matter

Bad tokenomics kills more crypto projects than bad code. The status quo for validating tokenomics before launch is:
1. Write a whitepaper with assumptions
2. Maybe run spreadsheet simulations
3. Launch and pray
4. Token dumps 90% because nobody modeled what happens when whales coordinate, governance gets captured, or yield incentives create death spirals

Existing tools fall short: TokenLab uses rule-based ABM, Cenit explicitly doesn't model adversarial behavior, Gauntlet is closed-source / enterprise-only / focused on lending parameters. Nobody has combined **LLM-driven adversarial agents + real on-chain execution + historical backtest validation** for tokenomics design.

Solana fits especially well: 400ms blocks map 1:1 to sim ticks, ZK-compressed accounts for cheap 1000+ agent wallets, Yellowstone gRPC for real-time observation, and Anchor program compatibility means a protocol team can hand us their unchanged programs and we deploy them on devnet with agents attacking them.

## Repo layout

```
sim-engine/        # Bun TypeScript — agent loop, LLM client, on-chain executor
  src/             # API server, worker, agents, llm, chain, ipc, report
  scenarios/       # luna-ust.ts, crv-curve.ts, swarm-100.ts
  runs-demo/       # baked-in pre-recorded NDJSON streams
  scripts/         # CLI entry points (bun luna, deploy-from-config, …)
frontend/          # Next.js 16 — landing, /demos, /simulate/[id], /report/[id], /about
  app/             # routes
  components/      # TopNav, ByokDialog, sim/* dashboard widgets, upload/*
  lib/             # api.ts, byok.ts, types.ts, threat.ts, scenarios.ts
programs/          # Anchor 1.0 programs (token mint, AMM, staking, governance)
infra/             # Dockerfile, Caddyfile, entrypoint.sh, AWS shell scripts
docs/              # scaling-handoff.md, deploy-handoff.md, plan.md, autonomy-plan.md
```

## Configuration knobs

Production-relevant env vars (full list in [docs/deploy-handoff.md](docs/deploy-handoff.md) §5):

| Env | Default | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | (unset; provided per-run via BYOK) | Server-side fallback only — production runs with no server key |
| `OPENROUTER_AGENT_PRESET` | (unset) | OpenRouter preset slug for the standard tier |
| `OPENROUTER_BOOST_PRESET` / `_REASONING_PRESET` / `_REPORT_PRESET` | (unset) | Three-tier routing + post-sim report model override |
| `SIM_REQUIRE_BYOK` | `0` (prod sets `1`) | Require `byokOpenRouterKey` on `POST /api/sim` |
| `SIM_DISABLE_ONCHAIN` | `0` (prod sets `1`) | Reject `onChain: true` create requests with 400 |
| `SIM_API_PORT` | `8787` | Bun API port. **Don't use `PORT`** — App Runner reserves it. |
| `SIM_ACTIVATION_POLICY` | `all` | `sampled` cuts swarm-100 cost by ~43% |
| `SIM_BATCH_SIZE` | `24` | Per-batch parallel-fetch fan-out |
| `SIM_PIPELINE` | (unset) | `1` enables pipelined batch dispatch (sacrifices delay-0 visibility) |
| `SIM_MAX_INFLIGHT` | `4` | Concurrent batches under pipeline mode |
| `SIM_MAX_AGENTS` | `5000` | Hard ceiling enforced in API |