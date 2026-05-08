#!/usr/bin/env bash
# 03-deploy.sh — create or update the SIMWARS App Runner service.
#
# First run creates the service. Subsequent runs call `update-service` —
# NOT `start-deployment` — so env-var changes (e.g. flipping on the on-chain
# block when DEPLOYER_KEYPAIR_SECRET_ARN is set) actually take effect.
# `update-service` triggers an automatic deployment once the new config
# applies; no separate `start-deployment` call needed.

source "$(dirname "$0")/env.sh"

ECR_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_ECR_ROLE}"
INSTANCE_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_INSTANCE_ROLE}"
IMAGE_URI="${ECR_URL}:latest"

# ────────────────────────────────────────────────────────────────────────────
# Build the env block. Devnet on-chain knobs only get attached when
# DEPLOYER_KEYPAIR_SECRET_ARN is set (i.e. the user has run deploy-devnet.sh
# and pushed the keypair to Secrets Manager). Without the ARN we ship in
# localnet mode and on-chain runs fail at the SDK layer — clean failure
# instead of half-configured devnet.
# ────────────────────────────────────────────────────────────────────────────
ONCHAIN_ENV=""
if [ -n "${DEPLOYER_KEYPAIR_SECRET_ARN}" ]; then
  ONCHAIN_ENV=",
          \"SOLANA_NETWORK\": \"devnet\",
          \"DEVNET_PROGRAMS_PATH\": \"/app/infra/onchain/devnet-programs.json\",
          \"DEPLOYER_KEYPAIR_SECRET_ARN\": \"${DEPLOYER_KEYPAIR_SECRET_ARN}\",
          \"SIM_ONCHAIN_RATE_LIMIT_PER_IP\": \"3\""
  echo "  on-chain mode: devnet (keypair from ${DEPLOYER_KEYPAIR_SECRET_ARN})"
else
  echo "  on-chain mode: disabled (set DEPLOYER_KEYPAIR_SECRET_ARN to enable)"
fi

# Source configuration — the only block that update-service and create-service
# share verbatim. Build it once.
#
# AutoDeploymentsEnabled is OFF on purpose: when ON, an ECR push from
# 02-build-push.sh auto-deploys with the *current* env vars, which races
# against this script's `update-service` and can leave the service running
# stale config. With it OFF, only this script's update-service triggers a
# deployment — image + env change atomically.
SOURCE_CONFIG=$(cat <<EOF
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE_URI}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentVariables": {
        "SIM_REQUIRE_BYOK": "1",
        "SIM_API_PORT": "8787",
        "NEXT_PORT": "3000",
        "PUBLIC_PORT": "8080",
        "SIM_RATE_LIMIT_PER_IP": "10",
        "SIM_RATE_LIMIT_PER_KEY": "20",
        "SIM_RATE_LIMIT_WINDOW_MS": "3600000"${ONCHAIN_ENV}
      }
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": {
    "AccessRoleArn": "${ECR_ROLE_ARN}"
  }
}
EOF
)

INSTANCE_CONFIG=$(cat <<EOF
{
  "Cpu": "4 vCPU",
  "Memory": "8 GB",
  "InstanceRoleArn": "${INSTANCE_ROLE_ARN}"
}
EOF
)

# Look up service ARN
SERVICE_ARN=$(aws_run apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "${SERVICE_ARN}" ] || [ "${SERVICE_ARN}" = "None" ]; then
  echo "════════════════════════════════════════════════════════════"
  echo "  Creating App Runner service ${APP_RUNNER_SERVICE}"
  echo "════════════════════════════════════════════════════════════"

  CREATE_INPUT=$(cat <<EOF
{
  "ServiceName": "${APP_RUNNER_SERVICE}",
  "SourceConfiguration": ${SOURCE_CONFIG},
  "InstanceConfiguration": ${INSTANCE_CONFIG},
  "HealthCheckConfiguration": {
    "Protocol": "HTTP",
    "Path": "/health",
    "Interval": 10,
    "Timeout": 5,
    "HealthyThreshold": 1,
    "UnhealthyThreshold": 3
  }
}
EOF
)
  aws_run apprunner create-service --cli-input-json "${CREATE_INPUT}"
  echo "  service creation kicked off (~5–10 min)"
else
  echo "════════════════════════════════════════════════════════════"
  echo "  Updating App Runner service ${APP_RUNNER_SERVICE}"
  echo "  (service ARN: ${SERVICE_ARN})"
  echo "════════════════════════════════════════════════════════════"

  # update-service applies the new config (including env vars) and triggers
  # a deployment automatically. We pass the source AND instance config so
  # any drift in the role ARN or instance size is corrected on each run.
  aws_run apprunner update-service \
    --service-arn "${SERVICE_ARN}" \
    --source-configuration "${SOURCE_CONFIG}" \
    --instance-configuration "${INSTANCE_CONFIG}"
  echo "  update kicked off — deployment runs automatically (~5–10 min)"
fi

echo
echo "Watch status:"
echo "  aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner describe-service \\"
echo "    --service-arn \"\$(aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner list-services --query \"ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]\" --output text)\" \\"
echo "    --query 'Service.[Status, ServiceUrl]' --output table"
