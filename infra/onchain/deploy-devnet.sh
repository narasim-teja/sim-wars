#!/usr/bin/env bash
# deploy-devnet.sh — one-shot deploy of the four Anchor programs to Solana
# devnet, populating infra/onchain/devnet-programs.json with the resulting
# program IDs. Run once before deploying the container with SOLANA_NETWORK=devnet.
#
# Idempotent: re-running redeploys (`anchor deploy` upgrades the existing
# program at its keypair-derived address) and rewrites the JSON file with
# the same IDs.
#
# Cost: program deploys are ~3–5 SOL each (programs are large BPF binaries).
# Per-sim costs after deploy are ~0.01 SOL (mints + PDAs + ATAs).
#
# Prereqs:
#   - solana CLI configured with a funded devnet wallet (>= 20 SOL recommended
#     for the initial deploy of all four programs)
#   - anchor CLI 1.0.0 (matches Anchor.toml)
#   - jq installed (for JSON manipulation)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_PATH="${REPO_ROOT}/infra/onchain/devnet-programs.json"
DEPLOY_DIR="${REPO_ROOT}/target/deploy"

PROGRAMS=("token_mint" "amm_dex" "staking" "governance")

# JSON-path mapping: anchor program name → key in devnet-programs.json.
# Implemented as a case statement (vs `declare -A`) so the script runs on
# macOS's stock bash 3.2 which lacks associative arrays.
json_key_for() {
  case "$1" in
    token_mint)  echo "tokenMint" ;;
    amm_dex)     echo "ammDex" ;;
    staking)     echo "staking" ;;
    governance)  echo "governance" ;;
    *)           echo "ERROR: unknown program $1" >&2; return 1 ;;
  esac
}

# Print a step header
step() {
  echo
  echo "──── $1 ────────────────────────────────────────────"
}

# Sanity checks
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 not found in PATH. Install it before running this script."
    exit 1
  fi
}

need solana
need anchor
need jq
need solana-keygen

step "1/5  Cluster + wallet sanity"
solana config set --url https://api.devnet.solana.com >/dev/null
# `solana config get` emits trailing whitespace after the value; strip it
# (and any quoting) so paths with no space don't end up looking like they have one.
WALLET="$(solana config get keypair | awk -F': ' '{print $2}' | sed 's/[[:space:]]*$//')"
PUBKEY="$(solana-keygen pubkey "${WALLET}")"
BAL_LAMPORTS="$(solana balance --lamports | awk '{print $1}')"
BAL_SOL="$(awk -v l="${BAL_LAMPORTS}" 'BEGIN{ printf "%.4f", l/1000000000 }')"
echo "  cluster:   devnet"
echo "  wallet:    ${WALLET}"
echo "  pubkey:    ${PUBKEY}"
echo "  balance:   ${BAL_SOL} SOL"

if (( BAL_LAMPORTS < 5000000000 )); then
  echo
  echo "  WARN: balance under 5 SOL. Each program deploy costs ~2–5 SOL."
  echo "        Run: solana airdrop 5   (devnet airdrop is rate-limited; may need"
  echo "        multiple calls or a faucet bot like https://faucet.solana.com)"
  read -r -p "  continue anyway? [y/N] " yn
  [[ "${yn:-N}" =~ ^[Yy]$ ]] || exit 1
fi

step "2/5  anchor build"
cd "${REPO_ROOT}"
# --ignore-keys: Anchor 1.0 setup; see memory/anchor_build_workaround.md
anchor build --ignore-keys

# Verify each program keypair exists post-build
for name in "${PROGRAMS[@]}"; do
  kp="${DEPLOY_DIR}/${name}-keypair.json"
  if [[ ! -f "${kp}" ]]; then
    echo "ERROR: missing program keypair ${kp} after anchor build"
    exit 1
  fi
done

step "3/5  anchor deploy (one program at a time)"
for name in "${PROGRAMS[@]}"; do
  echo "  → deploying ${name}…"
  # --program-name routes anchor to the right artifact + keypair. The keypair
  # at target/deploy/<name>-keypair.json defines the deploy address; the same
  # keypair is reused on re-runs so the program upgrades in place.
  anchor deploy --program-name "${name}" --provider.cluster devnet
done

step "4/5  capture program IDs"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

# Build the JSON in a tmp file then atomically replace the target. This way
# a partial run won't leave the file half-written.
jq --arg cluster "devnet" \
   '{ "_doc": ._doc, "cluster": $cluster, "programs": .programs }' \
   "${CONFIG_PATH}" > "${TMP}"

for name in "${PROGRAMS[@]}"; do
  kp="${DEPLOY_DIR}/${name}-keypair.json"
  pubkey="$(solana-keygen pubkey "${kp}")"
  json_key="$(json_key_for "${name}")"
  echo "  ${json_key}: ${pubkey}"
  jq --arg k "${json_key}" --arg v "${pubkey}" \
     '.programs[$k] = $v' \
     "${TMP}" > "${TMP}.next"
  mv "${TMP}.next" "${TMP}"
done

mv "${TMP}" "${CONFIG_PATH}"

step "5/5  verify"
echo "  wrote ${CONFIG_PATH}:"
jq . "${CONFIG_PATH}"

echo
echo "════════════════════════════════════════════════════════════"
echo "  DEVNET DEPLOY COMPLETE"
echo
echo "  Next:"
echo "    1. Commit ${CONFIG_PATH#${REPO_ROOT}/}"
echo "    2. Push the deployer keypair to AWS Secrets Manager:"
echo "         aws secretsmanager create-secret \\"
echo "           --name simwars/deployer-keypair \\"
echo "           --secret-string file://${WALLET} \\"
echo "           --region us-east-1"
echo "    3. Re-run infra/aws/01-bootstrap.sh (grants the instance role"
echo "       permission to read that secret)"
echo "    4. Re-run infra/aws/02-build-push.sh + 03-deploy.sh"
echo "════════════════════════════════════════════════════════════"
