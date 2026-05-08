#!/usr/bin/env bash
set -euo pipefail

# SIMWARS container entrypoint.
#
# Three processes share the container — Next.js (Node), sim-engine API (Bun),
# and Caddy reverse proxy. They are started in the background; `wait -n`
# returns when ANY of them exits, at which point we tear the others down so
# App Runner restarts the whole container instead of running half-broken.
#
# Logs from all three go to stdout/stderr → CloudWatch via App Runner.

cd /app

echo "[entrypoint] booting SIMWARS"
echo "[entrypoint] BYOK required:     ${SIM_REQUIRE_BYOK:-0}"
echo "[entrypoint] on-chain disabled: ${SIM_DISABLE_ONCHAIN:-0}"
echo "[entrypoint] solana network:    ${SOLANA_NETWORK:-localnet}"
echo "[entrypoint] runs dir:          ${SIM_RUNS_DIR:-/app/runs}"
echo "[entrypoint] demos dir:         ${SIM_DEMO_RUNS_DIR:-/app/sim-engine/runs-demo}"

# Fetch the Solana deployer keypair from AWS Secrets Manager and write it to
# disk for Anchor to consume. Only runs when the ARN is configured (i.e. the
# devnet on-chain path is wired); on local builds the var is empty and we
# skip silently. The secret is a JSON array of bytes — same shape produced
# by `solana-keygen new --outfile`.
if [ -n "${DEPLOYER_KEYPAIR_SECRET_ARN:-}" ]; then
  echo "[entrypoint] fetching deployer keypair from Secrets Manager"
  KEYPAIR_PATH="${ANCHOR_WALLET:-/tmp/anchor-wallet.json}"
  if ! aws secretsmanager get-secret-value \
        --secret-id "${DEPLOYER_KEYPAIR_SECRET_ARN}" \
        --region "${AWS_REGION:-us-east-1}" \
        --query SecretString --output text > "${KEYPAIR_PATH}"; then
    echo "[entrypoint] FATAL: failed to fetch deployer keypair (secret ARN, IAM role?)"
    exit 1
  fi
  chmod 600 "${KEYPAIR_PATH}"
  export ANCHOR_WALLET="${KEYPAIR_PATH}"
  echo "[entrypoint] wrote deployer keypair to ${KEYPAIR_PATH}"
fi

# 1. Sim-engine API (Bun) on :8787
(
  cd sim-engine
  echo "[entrypoint] starting sim-engine API on :${SIM_API_PORT:-${PORT:-8787}}"
  exec bun run src/api/server.ts
) &
API_PID=$!

# 2. Next.js production server on :3000 (Node)
(
  cd frontend
  echo "[entrypoint] starting Next.js on :${NEXT_PORT:-3000}"
  exec node node_modules/next/dist/bin/next start \
    --port "${NEXT_PORT:-3000}" \
    --hostname 0.0.0.0
) &
NEXT_PID=$!

# 3. Caddy reverse proxy on :8080 (the only public port)
(
  echo "[entrypoint] starting Caddy on :${PUBLIC_PORT:-8080}"
  exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
) &
CADDY_PID=$!

# Forward SIGTERM/SIGINT to children so App Runner can stop us gracefully.
trap 'echo "[entrypoint] received signal, stopping children"; kill -TERM $API_PID $NEXT_PID $CADDY_PID 2>/dev/null || true' SIGTERM SIGINT

# Block on first death.
wait -n
EXIT_CODE=$?
echo "[entrypoint] one process exited with code $EXIT_CODE — tearing down"
kill -TERM $API_PID $NEXT_PID $CADDY_PID 2>/dev/null || true
wait 2>/dev/null || true
exit $EXIT_CODE
