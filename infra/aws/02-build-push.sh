#!/usr/bin/env bash
# 02-build-push.sh — build the linux/amd64 SIMWARS image and push to ECR.
#
# Tags pushed:
#   :latest           always points at this build
#   :<short-sha>      immutable provenance tag (used by App Runner pin)

source "$(dirname "$0")/env.sh"

cd "$(dirname "$0")/../.."

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
