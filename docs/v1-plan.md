# SIMWARS v1 plan — from "deployed" to "shippable"

**Audience:** the next coding session (you-tomorrow or the next agent). Pair this with [deploy-handoff.md](./deploy-handoff.md) — that doc is the v0 record of what landed; this doc is what we ship next and why.

**Date:** 2026-05-07.
**Live URL:** `https://b5ikeexd9h.us-east-1.awsapprunner.com` (custom domain `simwars.xyz` waiting on Hostinger NS push).

---

## 1. Where we are (v0.1)

What works today on the AWS deploy:

- Single-container app on App Runner (Caddy + Bun API + Next.js). One push redeploys via `02-build-push.sh` + `03-deploy.sh`.
- BYOK plumbing — frontend stores OpenRouter key in localStorage/sessionStorage, server forwards to worker via env, integration test proves it never lands on disk. See [sim-engine/src/api/server.ts:99-122](../sim-engine/src/api/server.ts#L99-L122).
- Two pre-recorded demo runs at `/demos` (Curve veCRV, Uniswap UNI) — both *survive*. They serve through the same WS path as live runs by virtue of [resolveRunPaths](../sim-engine/src/ipc/paths.ts) falling back to `runs-demo/`.
- On-chain Anchor programs (token mint, AMM, staking, governance) compile and run on `solana-test-validator` locally. Production has them **off** via `SIM_DISABLE_ONCHAIN=1`.

What we deferred from v0:

- A real **LUNA death-spiral demo** (the Curve + UNI demos both survive, so there's no contrast story).
- **Solana on-chain on devnet** (the hackathon-essential path — flagged in [deploy-handoff.md §6.1](./deploy-handoff.md)).
- **Abuse protection.** BYOK protects our LLM bill, not our compute. A single user can spawn N workers and burn the App Runner instance.
- **Connecting the landing-page presets to the demos.** Today the LUNA / Curve preset cards on `/` trigger a *fresh* sim that needs an OpenRouter key. The pre-recorded demos live on a separate `/demos` page. The two surfaces are disconnected.

---

## 2. The four things v1 must fix

| # | Problem | Why it matters | Fix surface |
|---|---|---|---|
| **A** | Landing-page LUNA / Curve preset buttons launch a fresh ($0.04, BYOK-required) sim. | Reviewers / judges click LUNA, hit the BYOK wall, bounce. The two existing demos are buried at `/demos`. | Wire preset → "Replay this scenario" + a separate "Run a fresh one" button. |
| **B** | No LUNA demo recording exists. | The signature demo of this whole project is "watch a death spiral." We ship without it. | Record one locally with `bun luna`, copy to `runs-demo/`, add `DEMO_METADATA` entry. |
| **C** | Solana on-chain disabled in prod. | Solana hackathon submission expects an on-chain integration. | Pre-deploy programs to devnet once; pin program IDs; per-sim mints + PDAs only. |
| **D** | Anyone can launch unlimited sims → DoS our App Runner instance. | Even with BYOK, every `POST /api/sim` spawns a worker that holds CPU + RAM + disk for the whole tick budget. A loop in a tab drains us. | Per-IP + per-key rate limit. Optional Turnstile / hCaptcha for first-time launches. |

These are non-overlapping and can be worked in any order. Recommended order is **A → B → D → C** (cheapest UX wins first, hardest infra last).

---

## 3. The actual UX we're aiming for

Today's landing page is one long sequence: pick source → pick roster → click Deploy. The "demos" are a side dish at `/demos`.

What it should be:

```
┌─────────────────────────────────────────────────────────────┐
│ HERO                                                        │
│ "Upload your tokenomics. Stress-test the future."           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ "WATCH A REPLAY" — three big cards, no key required         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ LUNA-UST │  │  Curve   │  │ Uniswap  │                   │
│  │ ☠ death  │  │ ✓ S 91   │  │ ✓ A 89   │                   │
│  │ spiral   │  │ veToken  │  │ no peg   │                   │
│  │ tick 6   │  │ survives │  │ survives │                   │
│  └──────────┘  └──────────┘  └──────────┘                   │
│   click → /simulate/<demo-simId>  (instant replay)          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ "RUN YOUR OWN" — same flow as today                         │
│  - tokenomics source (preset clone OR upload)               │
│  - roster                                                   │
│  - tick params                                              │
│  - on-chain toggle (now actually works — devnet)            │
│  - BYOK gate                                                │
└─────────────────────────────────────────────────────────────┘
```

The three replay cards are the public face. The "run your own" form is the build-your-own surface for serious users. Currently the public face is a build-your-own form, which is backwards.

---

## 4. v1 work plan — phased

Each phase is intended to be one merge-and-redeploy cycle. Don't skip phases.

### Phase 1 — Wire the demo cards into the landing page (1–2 hours)

**Goal:** Hero gets a "Watch a replay" row of three cards above the build-your-own section. Clicking goes straight to `/simulate/<demoSimId>` — no BYOK prompt.

**Files:**
- [frontend/app/page.tsx](../frontend/app/page.tsx) — insert a new section between the hero and the existing source-picker. Fetch `/api/demos` on the server (same pattern as [frontend/app/demos/page.tsx](../frontend/app/demos/page.tsx)). Render three cards.
- [frontend/lib/api.ts](../frontend/lib/api.ts) — `listDemos()` already exists.
- Optionally trim the redundant `/demos` page to a "see all demos" overflow page, or delete it once the landing covers all three.

**Implementation note:** [page.tsx](../frontend/app/page.tsx) is a `"use client"` component. Either:
- (a) split off a tiny RSC parent that fetches `/api/demos` and passes it as a prop, OR
- (b) add a client-side `useEffect` that calls `listDemos()` on mount with a loading skeleton.

(a) is cleaner — converts the file into `app/page.tsx` (RSC) wrapping `<HomeClient demos={demos} />`. (b) is faster to ship.

**Test plan:**
- Cold-load `/` → three cards render.
- Click LUNA card → goes to `/simulate/<id>` and event stream replays.
- Click "Run your own" → BYOK still gated correctly.

### Phase 2 — Record + ship the LUNA demo (30–60 min)

**Goal:** Add a `runs-demo/<luna-uuid>/` directory with a real death-spiral run (price collapses >99% by tick 12) and a `DEMO_METADATA` entry.

**Files:**
- [sim-engine/src/api/server.ts:435-446](../sim-engine/src/api/server.ts#L435-L446) — add a third entry to `DEMO_METADATA`.
- `sim-engine/runs-demo/<new-uuid>/` — copy `events.ndjson` + `scenario.json` + `status.json` + `report.json` from a fresh local `bun luna` run.

**Steps:**

```bash
# 1. Run LUNA locally (uses OPENROUTER_API_KEY from .env)
cd sim-engine
bun luna  # → writes to .local/runs/<uuid>/

# 2. Verify death spiral
cat .local/runs/<uuid>/report.json | jq '{deathSpiralDetected, deathSpiralAtTick, finalPrice, resilienceGrade}'
# expected: deathSpiralDetected=true, finalPrice << initialPrice, grade F or D

# 3. Pick a stable simId for the demo (any UUID — keep separate from the run uuid)
LUNA_DEMO_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# 4. Copy
mkdir -p runs-demo/$LUNA_DEMO_ID
cp .local/runs/<uuid>/events.ndjson runs-demo/$LUNA_DEMO_ID/
cp .local/runs/<uuid>/scenario.json runs-demo/$LUNA_DEMO_ID/
cp .local/runs/<uuid>/status.json   runs-demo/$LUNA_DEMO_ID/
cp .local/runs/<uuid>/report.json   runs-demo/$LUNA_DEMO_ID/

# 5. Rewrite simId inside the JSON files so it matches the demo dir name
#    (events.ndjson references it in sim:start / sim:complete — keep them
#    consistent so the WS replay doesn't talk about a different id).
ORIG_ID=<paste from .local/runs/...>
for f in runs-demo/$LUNA_DEMO_ID/*.{json,ndjson}; do
  sed -i '' "s/$ORIG_ID/$LUNA_DEMO_ID/g" "$f"
done
```

Then add to [server.ts DEMO_METADATA](../sim-engine/src/api/server.ts#L435-L446):

```ts
"<LUNA_DEMO_ID>": {
  name: "LUNA-UST — algorithmic death spiral",
  description:
    "Anchor's 19.45% APY + algo stablecoin + zero lock = the May 2022 collapse. " +
    "Watch the burn-mint loop break the peg by tick 6, then UST → LUNA hyperinflation drives price to ~0.",
},
```

**Test plan:**
- `bun test` (the integration test asserts demo registration shape).
- Local `bun run api` → `curl localhost:8787/api/demos` returns three demos including LUNA.

### Phase 3 — Per-IP + per-key rate limit on POST /api/sim (1–2 hours)

**Goal:** A single IP or a single BYOK key can launch at most N sims/hour. Returns 429 above the limit.

**Why this and not full auth:** Full auth (Clerk, NextAuth, magic links) is multi-day work. For a public demo / hackathon submission, per-IP + per-key rate-limiting is the right level of friction — abusers are slowed; legitimate users see no UX change.

**Files:**
- [sim-engine/src/api/server.ts:93](../sim-engine/src/api/server.ts#L93) (`handleCreate`) — add a guard at the top.
- New: `sim-engine/src/api/rate-limit.ts` — sliding-window in-memory map. Resets on container restart (fine — App Runner restarts hourly anyway under load).

**Sketch:**

```ts
// rate-limit.ts
type Bucket = { tokens: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string, limit = 10, windowMs = 3600_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { tokens: limit - 1, resetAt: now + windowMs });
    return true;
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}
```

Wire in `handleCreate`:

```ts
const ipHeader = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
const ip = ipHeader.split(",")[0]?.trim() ?? "unknown";
if (!checkRateLimit(`ip:${ip}`, 10)) return json({ error: "rate limit: 10 sims/hour per IP" }, { status: 429 });
if (byokKey && !checkRateLimit(`key:${byokKey.slice(-8)}`, 20)) return json({ error: "rate limit: 20 sims/hour per key" }, { status: 429 });
```

**Why slice the key:** the bucket key shouldn't be the whole BYOK key (we never want it in a process map for longer than necessary). Last 8 chars is enough to disambiguate keys without persisting the whole thing.

**Trust the X-Forwarded-For from App Runner.** App Runner sets it. For Caddy behind App Runner you may need to also configure Caddy to forward it explicitly — check [infra/Caddyfile](../infra/Caddyfile) and add `header_up X-Forwarded-For {remote_host}` if missing.

**v2 follow-up:** add Cloudflare Turnstile to the launch button. Token verifies once, valid for the session — skip the captcha for the demo cards.

**Test plan:**
- POST `/api/sim` 11 times in <1h from same IP → 11th returns 429.
- Different keys from different IPs work concurrently.
- Demo cards (no `/api/sim` call) are unaffected.

### Phase 4 — Solana devnet on-chain (the big one — 1–2 days)

**Goal:** Drop `SIM_DISABLE_ONCHAIN=1`. When a user toggles "on-chain mode" on a custom run, the worker creates fresh mints + PDAs against pre-deployed devnet programs. No 4-program full deploy per sim.

This is the hackathon-essential item. It's also the riskiest — most chances to hit Solana / Anchor / RPC edge cases. Don't try to combine with phase 1–3 commits.

#### 4.1 Pre-deploy programs to devnet (one-time, ~5–10 SOL)

```bash
# Switch local Solana CLI to devnet, fund the deployer keypair, deploy each program
solana config set --url https://api.devnet.solana.com
solana airdrop 5  # rate-limited; may need to repeat or use a faucet bot

# Build + deploy each program. anchor deploy uses the keypair at programs/<name>/Anchor.toml
anchor deploy --program-name token_mint --provider.cluster devnet
anchor deploy --program-name amm_dex    --provider.cluster devnet
anchor deploy --program-name staking    --provider.cluster devnet
anchor deploy --program-name governance --provider.cluster devnet

# Capture the four program IDs into a config file
mkdir -p infra/onchain
cat > infra/onchain/devnet-programs.json <<EOF
{
  "cluster": "devnet",
  "programs": {
    "tokenMint":  "<id from anchor deploy output>",
    "ammDex":     "<...>",
    "staking":    "<...>",
    "governance": "<...>"
  }
}
EOF
```

#### 4.2 Update SDK to read pre-deployed program IDs

[sim-engine/src/chain/connection.ts](../sim-engine/src/chain/connection.ts) currently hardcodes program IDs from `programs/*/src/lib.rs` `declare_id!()` macros. For devnet we want runtime lookup:

```ts
// new fn in connection.ts
import { PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";

export function programIdsForCluster(cluster: string): {
  tokenMint: PublicKey; ammDex: PublicKey; staking: PublicKey; governance: PublicKey;
} {
  if (cluster === "localnet") {
    return { tokenMint: TOKEN_MINT_PROGRAM_ID, /* etc — current localnet ids */ };
  }
  const cfgPath = process.env.DEVNET_PROGRAMS_PATH ?? "infra/onchain/devnet-programs.json";
  if (!existsSync(cfgPath)) throw new Error(`Pre-deployed program IDs not found at ${cfgPath}. Run anchor deploy --provider.cluster devnet first.`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  return {
    tokenMint: new PublicKey(cfg.programs.tokenMint),
    ammDex:    new PublicKey(cfg.programs.ammDex),
    staking:   new PublicKey(cfg.programs.staking),
    governance:new PublicKey(cfg.programs.governance),
  };
}
```

Bake `infra/onchain/devnet-programs.json` into the container — it's static config, ~200 bytes.

#### 4.3 Admin keypair in AWS Secrets Manager

The deployer keypair (used by [scripts/deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts) to sign mint creation, pool init, PDA rent) must NOT be in the image. Per-sim it does ~5–10 cheap txs (a few thousand lamports each). Top up the keypair manually when it dips.

```bash
# Local — generate, fund, store
solana-keygen new --outfile ./simwars-deployer.json --no-bip39-passphrase
solana airdrop 2 ./simwars-deployer.json --url https://api.devnet.solana.com

# Push to Secrets Manager
aws secretsmanager create-secret \
  --name simwars/deployer-keypair \
  --secret-string file://./simwars-deployer.json \
  --region us-east-1

rm ./simwars-deployer.json  # keep it out of bash history / repo
```

Then in [infra/aws/01-bootstrap.sh](../infra/aws/01-bootstrap.sh) — give `AppRunnerInstanceRoleSimwars` permission to read this secret. In [infra/entrypoint.sh](../infra/entrypoint.sh) — fetch it on boot, write to `/tmp/anchor-wallet.json`, set `ANCHOR_WALLET=/tmp/anchor-wallet.json`.

```sh
# entrypoint.sh additions
if [ -n "$DEPLOYER_KEYPAIR_SECRET_ARN" ]; then
  aws secretsmanager get-secret-value --secret-id "$DEPLOYER_KEYPAIR_SECRET_ARN" \
    --region "${AWS_REGION:-us-east-1}" \
    --query SecretString --output text > /tmp/anchor-wallet.json
  chmod 600 /tmp/anchor-wallet.json
  export ANCHOR_WALLET=/tmp/anchor-wallet.json
fi
```

#### 4.4 Helius RPC

Public devnet (`https://api.devnet.solana.com`) is rate-limited to ~10 req/s; multi-agent sims will fail. Use Helius free tier:

```bash
# Sign up at helius.dev, grab the devnet endpoint URL with API key
aws secretsmanager create-secret \
  --name simwars/helius-rpc-url \
  --secret-string 'https://devnet.helius-rpc.com/?api-key=...' \
  --region us-east-1
```

Same secrets pattern as 4.3 — entrypoint reads → exports `ANCHOR_PROVIDER_URL`.

#### 4.5 Per-sim flow (no code change once 4.1–4.4 land)

[scripts/deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts) currently builds a per-sim `Deployment` manifest. With shared programs:

- `programs.tokenMint` etc. → from `infra/onchain/devnet-programs.json` (pre-deployed)
- `mints.base / quote` → fresh per-sim (cheap, just rent)
- `pool.address / vaults` → derived PDAs from the fresh mints (no program redeploy)
- `agents[].keypair` → fresh per-sim

The deploy script already does steps 2–4 — only step 1 changes. Most of the patch is inside `deploy-from-config.ts` near where it reads the program IDs.

#### 4.6 Drop the env gate, add a smaller one

In [infra/aws/03-deploy.sh](../infra/aws/03-deploy.sh):

```diff
-      { Name: "SIM_DISABLE_ONCHAIN",     Value: "1" },
+      // (removed)
+      { Name: "SIM_ONCHAIN_RATE_LIMIT",  Value: "3" },  // 3 onchain runs/hour/IP, on top of phase-3 limit
+      { Name: "SOLANA_NETWORK",          Value: "devnet" },
+      { Name: "DEVNET_PROGRAMS_PATH",    Value: "/app/infra/onchain/devnet-programs.json" },
+      { Name: "DEPLOYER_KEYPAIR_SECRET_ARN", Value: "arn:aws:secretsmanager:us-east-1:590183756653:secret:simwars/deployer-keypair-XXXXX" },
+      { Name: "RPC_URL_SECRET_ARN",      Value: "arn:aws:secretsmanager:us-east-1:590183756653:secret:simwars/helius-rpc-url-XXXXX" },
```

A lower cap on on-chain runs specifically (`SIM_ONCHAIN_RATE_LIMIT`) protects the deployer's SOL balance even if the per-IP limit is honored.

#### 4.7 Wallet adapter on the frontend (optional v1, definitely v2)

Lets users connect Phantom and (a) view tx signatures with a "view on Solana Explorer" link, (b) optionally sign their own actions. v1: just render the explorer links (deployment manifest already has all the addresses). v2: full adapter — `@solana/wallet-adapter-react` + `<WalletMultiButton/>`.

#### 4.8 Test plan

- Local `solana-test-validator` runs still pass — `bun test` is green.
- Manual: deploy a custom on-chain sim from prod with a small agent count (5). Watch chain:deploy:* events in the WS stream. Verify program IDs match `devnet-programs.json`. Verify Solana Explorer shows the txs.
- Run with 100 agents — check Helius RPC quota didn't exhaust.

---

## 5. Redeploy after each phase

Same as today (codified in [deploy-handoff.md §4](./deploy-handoff.md)):

```bash
# from repo root
bash infra/aws/02-build-push.sh     # rebuild + push :latest
bash infra/aws/03-deploy.sh         # triggers App Runner start-deployment

# watch
SVC=$(AWS_PROFILE=dev aws --region us-east-1 apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='simwars-web'].ServiceArn | [0]" --output text)
AWS_PROFILE=dev aws --region us-east-1 apprunner describe-service --service-arn "$SVC" \
  --query 'Service.[Status,ServiceUrl]' --output table
```

Phase 4 also needs a one-time `01-bootstrap.sh` re-run (idempotent — only adds the IAM policy for Secrets Manager).

---

## 6. v2 — backlog (do these too, just after the four blockers above)

These are not blocking the four problems in §2 — they layer on top once §4 lands.

| Item | Why defer | Source |
|---|---|---|
| **Persistent run history (S3)** | Today user runs die on container restart. Nice-to-have for sharing a sim someone else ran. | [deploy-handoff §6.5](./deploy-handoff.md) |
| **Paced replay** (`?speed=5x`) | Demos burst-load on WS connect. Pacing is a UX nicety, not a correctness fix. | [deploy-handoff §6.3](./deploy-handoff.md) |
| **Image slimming** | 1.47 GB → ~500 MB via Next standalone. Cold-start improvement, not a feature. | [deploy-handoff §6.6](./deploy-handoff.md) |
| **GitHub Actions auto-deploy** | Manual `02 + 03` shell scripts work fine for one developer. | [deploy-handoff §6.4](./deploy-handoff.md) |
| **Wallet adapter (full)** | Phase 4.7 is v1-lite (explorer links only). Full Phantom integration is v2. | this doc §4.7 |
| **Cost-meter polish** | "Recorded cost vs live cost" labeling on demos. | [deploy-handoff §6.7](./deploy-handoff.md) |
| **Sentry** | Wait for the first prod incident. | [deploy-handoff §6.8](./deploy-handoff.md) |
| **User accounts** | Only worth it if we charge. BYOK + rate-limit covers the public-tool case. | [deploy-handoff §6.9](./deploy-handoff.md) |
| **Image digest + git SHA in /about** | Pure ops hygiene. | [deploy-handoff §6.10](./deploy-handoff.md) |
| **Cloudflare Turnstile** | Phase-3 rate-limit covers MVP abuse. Add Turnstile if abuse persists. | this doc §4.3 |

---

## 7. Open questions (decide before phase 4)

1. **How much SOL do we top up the deployer keypair with?** Devnet airdrop is rate-limited. Best plan: airdrop 5 SOL, monitor balance via a CloudWatch alarm at <1 SOL, top up manually. We'll need ~0.01 SOL per on-chain sim once programs are pre-deployed.
2. **What's the on-chain agent funding floor?** Today [scripts/deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts) defaults to 5 SOL/agent for localnet. On devnet that's ridiculous — drop to 0.05 SOL/agent. Verify all agent actions still confirm.
3. **Do we let demos toggle on-chain replay?** No — demos are NDJSON recordings, no chain state to replay. Make sure the on-chain toggle is hidden when `mode === "demo"`.
4. **Helius tier — paid ($49/mo) is locked in.** Free tier was 100k credits/day; at ~50 RPC calls/agent/tick × 30 ticks × 100 agents = 150k credits/run, free tier wouldn't survive a single big run. Paid dev tier covers our throughput; no agent cap needed.

---

## 8. What "shipped" looks like

After v1 lands and we redeploy:

- `simwars.xyz` opens with three replay cards above the fold. Click any → instant replay with no key prompt.
- LUNA card is the first one and shows the death-spiral finale price + grade F badge. The contrast vs Curve/UNI tells the story without the user having to read.
- Custom run path still works, BYOK still gated.
- Toggling "on-chain mode" actually does something — produces real devnet tx signatures the user can click into Solana Explorer.
- Spamming Deploy & simulate from a single IP gets 429'd after 10 attempts; no more abuse risk.
- The `/about` page still says BYOK is the trust contract — and now we can also point at the on-chain txs as additional auditability.

That's the v1 we're shipping.

---

## 9. Reading order for the next agent

1. **This doc.** Get scope.
2. **[deploy-handoff.md](./deploy-handoff.md)** §1, §2, §5. Learn the prod topology + env knobs you can't change.
3. **[sim-engine/src/api/server.ts](../sim-engine/src/api/server.ts)** — `handleCreate`, `handleDemos`, `registerDemos`. Phase 1, 2, 3 all touch this file.
4. **[frontend/app/page.tsx](../frontend/app/page.tsx)** — phase 1 lives here.
5. **[scripts/deploy-from-config.ts](../sim-engine/scripts/deploy-from-config.ts)** + **[sim-engine/src/chain/connection.ts](../sim-engine/src/chain/connection.ts)** — only when starting phase 4.

Don't touch anything in `programs/` for v1. The Anchor program code is fine; we're changing how it's invoked (shared deploy vs per-sim deploy), not what it does.
