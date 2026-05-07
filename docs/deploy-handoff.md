# SIMWARS deploy + BYOK + replay handoff

**Audience:** the next coding agent picking up after the production deploy. Pair this with [scaling-handoff.md](./scaling-handoff.md) — that doc covers the LLM/agent path, this one covers everything that turns sim-wars into a public website.

**Mission (this session, from the user):**
1. Make sim-wars deployable on AWS as a real website behind a custom domain.
2. Switch the LLM model from server-keyed to **bring-your-own-key (BYOK)** so we don't pay for users' OpenRouter spend (the codebase is open-source — that's fine).
3. Bake in 2 pre-recorded demo runs so the public landing has something to show without anyone needing a key.
4. Disable the on-chain Solana path in production for now; tackle a real Solana devnet integration in v2.

**Status (2026-05-06):**
- Live at `https://b5ikeexd9h.us-east-1.awsapprunner.com` — full app, both demos replay, BYOK gate enforces.
- Custom domain `simwars.xyz` is wired in Route 53 with apex ALIAS + www CNAME + ACM cert validation CNAMEs, but **DNS at the .xyz registry is still on Hostinger's parking nameservers** as of this writing — once Hostinger pushes the NS change to the registry, ACM auto-validates and `https://simwars.xyz` goes live (~10 min after propagation).
- 85/85 tests pass. Frontend builds clean. Local container smoke test green.

---

## 1. AWS topology (us-east-1)

```
                 simwars.xyz / www.simwars.xyz
                          │
                  Route 53 hosted zone
              Z00672871WI6KJG93ADT5
                          │
                Apex ALIAS A → App Runner zone
                Z01915732ZBZKC8D32TPT
                          │
                ┌─────────┴─────────┐
                │  AWS App Runner   │
                │  simwars-web      │
                │  arn:…:service/   │
                │  simwars-web/…    │
                │  (1 vCPU / 2 GB)  │
                └─────────┬─────────┘
                          │ pulls :latest
                  ECR repo `simwars`
        590183756653.dkr.ecr.us-east-1.amazonaws.com/simwars
                          │
                  Caddy :8080 (in-container)
                ┌─────────┴─────────┐
            /api/*               /*
            /ws/*           
                │                  │
        Bun :8787             Next.js :3000
        sim-engine API        prod server
                │
        spawned worker procs
        runs/ + runs-demo/
```

**One container, three processes.** Caddy is the only public port (8080), reverse-proxies `/api/*` and `/ws/*` to the Bun API and everything else to Next.js. App Runner terminates TLS in front of Caddy.

**Why App Runner over ECS+ALB:** one concept, no VPC/security-group/target-group/listener config, native WebSocket, auto-HTTPS with custom domain, $50/mo. Move to ECS only when we outgrow it.

**Cost today:** ~$60/mo (App Runner $56, R53 $0.50, CloudWatch ~$3). Account credit balance handles this for years.

---

## 2. What landed in code

All paths relative to repo root `/Users/narasim/Code/work/sim-wars/`. Citations are file:line ranges as of the deploy commit.

### 2.1 BYOK plumbing (server-mediated, never persisted)

**Wire format:** the frontend POSTs `{ ..., byokOpenRouterKey: "sk-or-v1-..." }` to `/api/sim`. Server validates shape, strips the field before persisting `scenario.json`, and forwards the key to the spawned worker via `OPENROUTER_API_KEY` env. When the worker exits, the env vanishes with the process.

- **[sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts)** — added `byokOpenRouterKey?: string` to `CreateSimBody`, `isPlausibleOpenRouterKey()` validator (`sk-or-…`, max 200 chars), `REQUIRE_BYOK` and `DISABLE_ONCHAIN` env-driven gates. The `delete persistedBody.byokOpenRouterKey;` line is the redaction that keeps the key off disk.
- **Test:** `sim-engine/src/api/server.integration.test.ts` — two new asserts. One rejects malformed keys with 400; one POSTs a valid-shape fake key, then re-reads `scenario.json` and asserts neither the key string nor the `byokOpenRouterKey` field name appears. **This test is the contract.** If you change BYOK plumbing, run it.
- **[frontend/lib/byok.ts](../frontend/lib/byok.ts)** — small store. localStorage when "remember on this device" is ticked; sessionStorage otherwise. Loose key-shape check mirrors the server.
- **[frontend/components/ByokDialog.tsx](../frontend/components/ByokDialog.tsx)** — modal triggered when launching a non-demo sim without a stored key. Trust copy in the body explains the contract.
- **[frontend/app/page.tsx](../frontend/app/page.tsx)** — `launch()` was refactored to take an optional `keyOverride` parameter. When the dialog submits, it calls `launch(key)` directly instead of waiting on React state to commit. The key goes into `body.byokOpenRouterKey` on the create-sim call.

**Why server-mediated and not browser-direct OpenRouter:** moving the entire batch orchestrator into the browser would be a major refactor and break the worker subprocess model. Server-mediated is the standard pattern; auditability is the trust mechanism.

### 2.2 Demo replay infrastructure

Two pre-recorded NDJSON event streams ship inside the image at `sim-engine/runs-demo/`:

| simId | Source | Ticks | Grade | Story |
|---|---|---|---|---|
| `4cc74be3-…b86a4` | curve-ish veToken | 82 events | S (91) | sustainable lock survives stress |
| `b3c55764-…4dae` | Uniswap UNI clone | 64 events | A (89) | community float, governance survives |

Each demo dir contains `events.ndjson`, `scenario.json`, `status.json`, `report.json`. Total 2.1 MB.

- **[sim-engine/src/ipc/paths.ts](../sim-engine/src/ipc/paths.ts)** — added `DEMO_RUNS_DIR` (overrideable via `SIM_DEMO_RUNS_DIR`), `resolveRunPaths(simId)` (live → demo fallback), `isDemoRun(simId)`.
- **[sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts)** — `registerDemos()` runs at boot, scans `runs-demo/`, registers each subdir in the `runs` map with `eventsOffset = file size` so the periodic tailer treats them as quiescent. New `GET /api/demos` returns hand-curated metadata cards (see `DEMO_METADATA` in the same file). `handleStatus` and `handleReport` use `resolveRunPaths` so demos serve through the same endpoints as live runs. `handleCommand` returns 409 for any demo simId — pause/resume/abort are read-only no-ops on a recording.
- **[frontend/app/demos/page.tsx](../frontend/app/demos/page.tsx)** — server-side fetches `/api/demos` and renders cards linking to `/simulate/<demo simId>`. Replay is just `useSimulation(demoId)` — the existing WebSocket handler in [server.ts:onWsOpen](../sim-engine/src/api/server.ts) flushes the entire `events.ndjson` on connect, which gets the frontend to final state instantly.

**Replay is currently instant, not paced.** The events all arrive in a burst right after WS connect. v2 idea: a `?speed=5x` query that replays events using their original `ts` deltas scaled by N.

### 2.3 Production safety flags

Two env-driven gates added to the API server. Both default off (compatible with local dev), turned on at deploy time via App Runner env config.

- `SIM_REQUIRE_BYOK=1` — `POST /api/sim` returns 402 if `byokOpenRouterKey` is missing. Demos are unaffected (no `/api/sim` call involved).
- `SIM_DISABLE_ONCHAIN=1` — `POST /api/sim` with `onChain: true` returns 400. v1 disables this entirely; v2 will gate it differently (see §6).

Both wired in [src/api/server.ts](../sim-engine/src/api/server.ts) at `handleCreate` entry.

### 2.4 Container shape

Single Dockerfile produces a 1.47 GB image (480 MB compressed in ECR). Three processes share the container:

1. **Caddy on :8080** — reverse proxy. Public port. Routes `/ws/*` (WebSocket upgrade), `/api/*`, `/health` to the Bun API; everything else to Next.js. See [infra/Caddyfile](../infra/Caddyfile).
2. **Bun on :8787** — sim-engine API. Spawns one worker subprocess per active simulation.
3. **Node on :3000** — Next.js production server (`next start`). Bun could run Next 16 too but Node is rock-solid for prod.

**Entrypoint** ([infra/entrypoint.sh](../infra/entrypoint.sh)) starts all three with `&`, traps SIGTERM/SIGINT, and uses `wait -n` to die when ANY child exits — App Runner restarts the whole container if one process dies, instead of running half-broken.

**Image breakdown** (rough):
- `oven/bun:1.3-debian` base + `apt install nodejs caddy tini` ≈ 800 MB
- `frontend/node_modules` (Next 16 + React 19 + recharts + base-ui + shadcn deps) ≈ 500 MB
- `sim-engine/node_modules` + Bun deps ≈ 50 MB
- Frontend `.next` build output ≈ 100 MB
- Demos + scenarios + source ≈ a few MB

**Slimming for v2** is one of the easier wins (§6.6).

### 2.5 The PORT gotcha

**App Runner reserves the `PORT` env variable** — it auto-injects `PORT=<configured forward port>` (8080 in our case) and silently ignores any override you put in `RuntimeEnvironmentVariables`. This collided with the sim-engine API which also read `process.env.PORT` (default 8787) and tried to bind it. The result was two `EADDRINUSE` deploy failures before I found it.

**The fix:** sim-engine reads `SIM_API_PORT` first, falls back to `PORT`, defaults to 8787.

- [sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts) — `const PORT = Number(process.env.SIM_API_PORT ?? process.env.PORT ?? 8787);`
- [Dockerfile](../Dockerfile) — sets `ENV SIM_API_PORT=8787` (informational; entrypoint reads this)
- [infra/aws/03-deploy.sh](../infra/aws/03-deploy.sh) — sets `SIM_API_PORT=8787` in `RuntimeEnvironmentVariables`
- [infra/entrypoint.sh](../infra/entrypoint.sh) — boot log echoes `SIM_API_PORT:-${PORT:-8787}`

**Don't rename `SIM_API_PORT` back to `PORT`. App Runner will silently clobber it.**

### 2.6 Frontend additions

- **`/demos` page** — described in §2.2.
- **`/about` page** — surfaces the BYOK trust contract, architecture summary, git SHA + image digest from build env (`NEXT_PUBLIC_GIT_SHA`, `NEXT_PUBLIC_IMAGE_DIGEST` — currently unset; v2 should populate from the build pipeline).
- **TopNav** — added Launch/Demos/About links and pointed the GitHub link at the real repo.
- **API_BASE default change** — [frontend/lib/api.ts](../frontend/lib/api.ts) now defaults `API_BASE = ""` (relative URLs) so production same-origin "just works." Override `NEXT_PUBLIC_SIM_API` only for local dev pointing at a separate sim-engine on :8787.
- **BYOK key-status strip** — visible above the launch button on [frontend/app/page.tsx](../frontend/app/page.tsx). Shows masked key + "remembered" / "session only", with `clear` and `change` buttons.

---

## 3. AWS infrastructure scripts

All in [infra/aws/](../infra/aws/). Idempotent — re-running creates only what's missing. Source one common env file:

- **[env.sh](../infra/aws/env.sh)** — shared variables. `AWS_ACCOUNT_ID` is intentionally **required** (`:?` syntax) so the account id stays out of the repo. Set it in your shell profile: `export AWS_ACCOUNT_ID=...`.
- **[01-bootstrap.sh](../infra/aws/01-bootstrap.sh)** — Route 53 hosted zone for the domain, ECR repo `simwars`, IAM role `AppRunnerECRAccessRoleSimwars` (App Runner pulls from ECR), IAM role `AppRunnerInstanceRoleSimwars` (runtime; currently no extra policies). **Prints the 4 nameservers** for the user to paste into their registrar.
- **[02-build-push.sh](../infra/aws/02-build-push.sh)** — `docker buildx build --platform linux/amd64 --push` to ECR. Tags `:latest` and `:<short git sha>`.
- **[03-deploy.sh](../infra/aws/03-deploy.sh)** — first run `create-service`, subsequent runs `start-deployment` (which pulls `:latest` again). 1 vCPU + 2 GB instance. Health check on `/health` every 10s.
- **[04-domain.sh](../infra/aws/04-domain.sh)** — associates the custom domain, fetches ACM validation records from App Runner, writes a Route 53 ChangeBatch with **apex ALIAS A** (not CNAME — that's invalid at apex), www CNAME, and the validation CNAMEs.

**Don't switch to Terraform/CDK yet.** Single-stack deploy. Shell scripts are the right tool for the job until we have multiple environments (staging/prod) or shared infra.

---

## 4. Live deployment state

| Resource | Value |
|---|---|
| AWS account | `590183756653` (profile `dev`, IAM user `narasim`) |
| Region | `us-east-1` |
| Hosted zone ID | `Z00672871WI6KJG93ADT5` (for `simwars.xyz`) |
| ECR repo | `590183756653.dkr.ecr.us-east-1.amazonaws.com/simwars` |
| App Runner service | `simwars-web` |
| App Runner URL | `https://b5ikeexd9h.us-east-1.awsapprunner.com` |
| App Runner ALIAS HZ (us-east-1) | `Z01915732ZBZKC8D32TPT` |
| Custom domain | `simwars.xyz` (status: `pending_certificate_dns_validation`) |
| Image tag deployed | matches git short SHA at deploy time + `:latest` |

**To redeploy on a code change:**
```bash
cd /path/to/sim-wars
bash infra/aws/02-build-push.sh   # rebuild + push :latest
bash infra/aws/03-deploy.sh       # triggers start-deployment
```

**To watch a deploy:**
```bash
SVC=$(AWS_PROFILE=dev aws --region us-east-1 apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='simwars-web'].ServiceArn | [0]" --output text)
AWS_PROFILE=dev aws --region us-east-1 apprunner describe-service --service-arn "$SVC" \
  --query 'Service.[Status,ServiceUrl]' --output table
```

**To tail logs:**
```bash
SVC_ID=${SVC##*/}
AWS_PROFILE=dev aws --region us-east-1 logs tail \
  "/aws/apprunner/simwars-web/$SVC_ID/application" --follow --format short
```

---

## 5. Knobs the next agent should know about

Production env (set via `RuntimeEnvironmentVariables` in [03-deploy.sh](../infra/aws/03-deploy.sh)):

| Env | Value in prod | Effect |
|---|---|---|
| `SIM_REQUIRE_BYOK` | `1` | `POST /api/sim` requires `byokOpenRouterKey` (402 otherwise) |
| `SIM_DISABLE_ONCHAIN` | `1` | rejects `onChain: true` create requests with 400 |
| `SIM_API_PORT` | `8787` | port the Bun API binds to (must NOT be `PORT` — App Runner reserves that) |
| `NEXT_PORT` | `3000` | Next.js production server port |
| `PUBLIC_PORT` | `8080` | Caddy port (App Runner forward target) |
| `SIM_RUNS_DIR` | `/app/runs` | writable runs dir (ephemeral — App Runner has no volume) |
| `SIM_DEMO_RUNS_DIR` | `/app/sim-engine/runs-demo` | read-only baked-in demos |
| `NEXT_PUBLIC_SIM_API` | `""` (empty) | client uses relative URLs, same-origin |

**Not set in prod (intentional):**
- `OPENROUTER_API_KEY` — the BYOK model means there is no server-wide key. Each worker gets the user's key via env at spawn and dies with it.
- `OPENROUTER_*_PRESET` — none required server-side. Workers inherit env from the API server, which doesn't set them, so the LLM provider picks defaults that work with whatever key the user provided.
- `CHAIN_DEPLOYMENT` — on-chain disabled.

---

## 6. v2 backlog (rough priority)

### 6.1 Solana on-chain on devnet (the hackathon-essential one)

User explicitly flagged this as essential for the Solana hackathon submission but agreed to defer past v1. The v1 deployment hard-disables on-chain via `SIM_DISABLE_ONCHAIN=1`. v2 needs:

1. **Pre-deploy programs once to devnet**, NOT per-sim. Current code in `scripts/deploy-from-config.ts` does a fresh per-sim deploy of all 4 programs (token mint, AMM, staking, governance), which costs ~3–5 SOL each — fine on localnet, ruinous on devnet (faucet rate-limited).
2. Pin the program IDs in `infra/onchain/devnet-programs.json` and load them in [chain/sdk.ts](../sim-engine/src/chain/sdk.ts) when `SOLANA_NETWORK=devnet`.
3. Each user sim then calls those existing programs to mint a fresh token + create per-sim PDAs (a few cheap txs per sim, not a 4-program deploy).
4. **Admin keypair** (small SOL balance for paying PDA rent) lives in **AWS Secrets Manager** — this is the first reason we'd add Secrets Manager to the deploy. Mount via App Runner instance role.
5. **RPC endpoint** — public devnet (`https://api.devnet.solana.com`) is rate-limited; use Helius free tier (`https://devnet.helius-rpc.com/?api-key=...`) for any meaningful traffic. Helius key also goes in Secrets Manager.
6. **Wallet adapter** in the frontend so users who want to sign their own actions can connect Phantom/Solflare. For demo replay we just show the recorded txs.
7. Drop `SIM_DISABLE_ONCHAIN=1` from prod env once tested. Add a per-request rate limit instead so a single user can't burn through devnet rent.

This is meaningful work — at least a day. Don't conflate with smaller v2 items.

### 6.2 Re-record demos with a real LUNA death-spiral

The two current demos (Curve veCRV, Uniswap UNI) both survive — both grade A/S. The original plan was LUNA-vs-Curve (death spiral vs survival) for narrative contrast. We shipped what existed in `.local/runs/` because the user picked "use existing for now."

**To do:** locally run `bun luna` (writes to `.local/runs/<uuid>/`), pick the resulting run directory, copy it to `sim-engine/runs-demo/<new uuid>/` (events.ndjson + scenario.json + status.json + report.json — skip sim.sqlite), then add a `DEMO_METADATA` entry in [sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts). Costs ~$0.015 of OpenRouter to re-record. Optional: rename the simId for stability (find/replace inside the JSON files — the events stream references the simId in some `kind: "sim:start" / "sim:complete"` entries).

### 6.3 Paced replay

Demo replay is currently instant — `onWsOpen` flushes the whole events.ndjson on connect. Implement an optional `?speed=Nx` query param that replays events using their original `ts` deltas scaled by `1/N`. Default to instant (current behavior); paced is opt-in.

Implementation hint: split the `onWsOpen` flush into a generator. When `paced` is set, `await Bun.sleep((next.ts - prev.ts) / N)` between sends.

### 6.4 GitHub Actions auto-deploy

Today the deploy is `bash 02-build-push.sh && bash 03-deploy.sh` from the dev machine. Move to a GitHub Actions workflow on push to `main`:

1. AWS OIDC role (no long-lived AWS keys in GH secrets — use `aws-actions/configure-aws-credentials@v4` with `role-to-assume`).
2. `docker buildx build --platform linux/amd64 --push` to ECR.
3. `aws apprunner start-deployment` to roll the service.
4. Optional: gate on `bun test` + `next build` succeeding first.

Skip until the first time you have to redeploy from someone else's machine.

### 6.5 Persistent run history

Today user-launched runs live in the App Runner instance's local disk and die on every restart/redeploy. The 3 baked-in demos are the only persistent runs.

For v2: archive completed runs to S3 (`s3://simwars-runs/<simId>/`) on `sim:complete`. Add `GET /api/runs/recent` that lists the N most recent archived runs across all instances. Add a `/runs` page that's like `/demos` but for community-archived runs. Storage is cheap; ~50 KB per ndjson, plenty of headroom.

### 6.6 Image slimming

1.47 GB → target ~500 MB:

1. Use Next.js `output: "standalone"` in `next.config.ts` — produces a self-contained `.next/standalone/server.js` that doesn't need full `node_modules` at runtime. Saves ~400 MB.
2. Switch base from `oven/bun:1.3-debian` to `node:20-alpine` + curl-installed Bun. Saves ~200 MB but adds glibc-vs-musl edge cases.
3. Delete `pdfjs-dist` from the runtime stage — it's only used in the upload/extract path which doesn't need to run on the server (it runs in the browser). Saves ~100 MB. Audit other heavy `dependencies` for the same pattern.

Smaller image = faster cold starts on App Runner and cheaper ECR egress.

### 6.7 Cost-meter polish

The cost-meter ([sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts) sends `llmUsage` over WS, [frontend/components/sim/CostMeter.tsx](../frontend/components/sim/CostMeter.tsx) renders it) shows $0 for demos because the recorded events.ndjson carries the original `llmUsage` (cost frozen in time). Consider:

- Distinguish "this run cost $X" from "this run is replaying — total was $X originally" in the meter copy.
- Show running-total on the post-sim report page ([frontend/app/report/[id]/](../frontend/app/report/)). The data is already in `RunSimulationResult.llmUsage` (saved via `report.json`).

### 6.8 Sentry / error tracking

Today errors surface in CloudWatch Logs only. Add Sentry frontend SDK (or self-hosted alternative) with a DSN in `NEXT_PUBLIC_SENTRY_DSN`. Skip for now; revisit after first production issue.

### 6.9 Auth / rate limit

Public BYOK means no auth is fine — users pay their own LLM bill. But the server-side resources (CPU, RAM, ephemeral disk) are still ours. Add a per-IP rate limit on `POST /api/sim` (10/hour or so) once we see abuse. [sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts) is the spot.

Don't add user accounts unless we're charging — they're complexity for no current value.

### 6.10 Image digest + git SHA in /about

[frontend/app/about/page.tsx](../frontend/app/about/page.tsx) reads `NEXT_PUBLIC_GIT_SHA` and `NEXT_PUBLIC_IMAGE_DIGEST` but neither is set today. Wire both in the build pipeline:

```dockerfile
# in builder stage
ARG GIT_SHA
ARG IMAGE_DIGEST
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA NEXT_PUBLIC_IMAGE_DIGEST=$IMAGE_DIGEST
```

[infra/aws/02-build-push.sh](../infra/aws/02-build-push.sh) already passes `GIT_SHA`. Add `IMAGE_DIGEST` after the push (read from `docker buildx imagetools inspect`).

---

## 7. Things that look like bugs but aren't

- **Demo runs return 409 on pause/resume/abort.** By design — there's no worker behind a recording, so commands can't take effect. UI hides the controls when `status.isDemo === true` is in the response.
- **App Runner clobbers `PORT` env var.** Documented in §2.5. Use `SIM_API_PORT`. Don't fight it.
- **Apex DNS: ALIAS A, not CNAME.** DNS spec doesn't allow CNAME at apex. Route 53 ALIAS A is the workaround. App Runner's regional ALIAS hosted zone for us-east-1 is `Z01915732ZBZKC8D32TPT` (hardcoded in [04-domain.sh](../infra/aws/04-domain.sh) but overrideable via `APPRUNNER_HOSTED_ZONE`).
- **Demo `events.ndjson` says `tick=29` in status.json but has 82 lines.** The line count includes `sim:start` / `tick:start` / `sim:complete` / `agent:action` / `report:*` events, not just `tick:complete` — `status.tick` is the last completed tick, which is correct.
- **Cost meter shows $0 during demo replay.** Demo `events.ndjson` was recorded with a real run that DID cost money — the costs are in the recorded events. The meter renders whatever `llmUsage` arrives. If you want to distinguish "free replay" from "live cost," that's §6.7.
- **`NEXT_PUBLIC_SIM_API=""` in prod.** Empty string is the signal for "use relative URLs." Caddy fronts both Next and the Bun API on the same origin so there's no CORS to manage and no separate API base.
- **`AWS_ACCOUNT_ID` is required, not defaulted.** Intentionally — keeps the account id out of the repo. Set it in `~/.zshrc` or pass inline.

---

## 8. Where to read the contract

If you only have time for three files before making changes, read these in order:

1. **[sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts)** — BYOK gate, demo registration, on-chain disable, all the production-facing entry points.
2. **[infra/aws/03-deploy.sh](../infra/aws/03-deploy.sh)** — what env App Runner sees, what role ARNs are in play, what the health check looks like. The truth about how the running service is configured.
3. **[Dockerfile](../Dockerfile)** + **[infra/Caddyfile](../infra/Caddyfile)** + **[infra/entrypoint.sh](../infra/entrypoint.sh)** — the runtime contract for the three processes inside the container.

Also worth a skim:

- **[scaling-handoff.md](./scaling-handoff.md)** — the prior handoff, covers the LLM/agent path. Still accurate.
- **[sim-engine/src/api/server.integration.test.ts](../sim-engine/src/api/server.integration.test.ts)** — the BYOK redaction test is the contract. If you change the redaction path, this is what proves it.
- **[frontend/app/page.tsx](../frontend/app/page.tsx)** — the launch flow + BYOK gate from the client side. The `keyOverride` parameter on `launch()` is load-bearing; don't remove it.

---

## 9. References

- App Runner WebSocket support: https://aws.amazon.com/blogs/aws/aws-app-runner-supports-websocket-and-the-go-1-x-php-runtimes/ (yes, WebSockets work; idle timeout is 120s but our ticks are 5–15s so streams never go idle)
- App Runner reserved env vars (incl. `PORT`): https://docs.aws.amazon.com/apprunner/latest/dg/security_iam_service-with-iam.html
- Route 53 ALIAS targets per region: https://docs.aws.amazon.com/general/latest/gr/apprunner.html
- OpenRouter BYOK + key shape: https://openrouter.ai/docs/api-reference/authentication
- The user's account context: profile `dev`, account `590183756653` (kept out of the repo via `:?` env requirement in `infra/aws/env.sh`).

---

## 10. TL;DR for the next agent

You inherit:
- A live, public deployment on AWS App Runner behind a (pending-DNS) custom domain.
- A BYOK model where the server forwards user-provided OpenRouter keys to spawned worker processes and never persists them. Integration test proves the redaction.
- Two replayable demo recordings baked into the image at `runs-demo/`. Demo simIds work like normal simIds through every API endpoint; commands are 409.
- A single-container shape (Caddy + Bun API + Next.js) that fits App Runner. SIM_API_PORT is the env name to use, not PORT (App Runner reserves it).
- AWS shell scripts in `infra/aws/` that bootstrap, build+push, deploy, and associate the custom domain. All idempotent.

The biggest remaining items are (a) Solana devnet on-chain — explicitly hackathon-essential per the user — using shared pre-deployed programs not per-sim deploys, (b) re-record a real LUNA death-spiral demo so the cards tell a contrast story, and (c) image slimming via Next.js standalone output.

Don't put `OPENROUTER_API_KEY` in Secrets Manager. The whole point of BYOK is that we don't have a server-wide LLM key. The first thing that goes in Secrets Manager will be the Solana admin keypair in v2.

Don't rename `SIM_API_PORT` back to `PORT`.

Don't put dynamic content in the archetype prompt zone (see scaling-handoff.md §3.2).

Run the integration tests + LUNA backtest after every meaningful change.
