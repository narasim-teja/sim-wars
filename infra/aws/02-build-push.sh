#!/usr/bin/env bash
# 02-build-push.sh — build the linux/amd64 SIMWARS image and push to ECR.
#
# Tags pushed:
#   :latest           always points at this build
#   :<short-sha>      immutable provenance tag (used by App Runner pin)

source "$(dirname "$0")/env.sh"

cd "$(dirname "$0")/../.."

# Anchor IDLs are required at runtime (sdk.ts loads them to invoke the
# pre-deployed programs). They live under target/idl which is .dockerignore'd
# except for this exception. Fail loudly if anchor build hasn't run yet —
# without this the image silently ships without IDLs and on-chain runs
# crash at the first program.methods call.
REQUIRED_IDLS=(token_mint amm_dex staking governance)
MISSING_IDLS=()
for name in "${REQUIRED_IDLS[@]}"; do
  if [ ! -f "target/idl/${name}.json" ]; then
    MISSING_IDLS+=("${name}")
  fi
done
if [ ${#MISSING_IDLS[@]} -ne 0 ]; then
  echo "ERROR: missing IDL files for: ${MISSING_IDLS[*]}"
  echo "       Run: anchor build --ignore-keys"
  echo "       (then re-run this script)"
  exit 1
fi

GIT_SHA=$(git rev-parse --short=12 HEAD)
echo "════════════════════════════════════════════════════════════"
echo "  Building image ${ECR_URL}:${GIT_SHA}"
echo "════════════════════════════════════════════════════════════"

# 1. ECR docker login
echo
echo "── ECR login ───────────────────────────────────────────────"
aws_run ecr get-login-password \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# 2. Build (linux/amd64 — App Runner doesn't support arm64)
echo
echo "── Build ───────────────────────────────────────────────────"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  --tag "${ECR_URL}:${GIT_SHA}" \
  --tag "${ECR_URL}:latest" \
  --push \
  .

echo
echo "════════════════════════════════════════════════════════════"
echo "  PUSH COMPLETE"
echo "  ${ECR_URL}:${GIT_SHA}"
echo "  ${ECR_URL}:latest"
echo "════════════════════════════════════════════════════════════"
