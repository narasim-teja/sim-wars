#!/usr/bin/env bash
# 03-deploy.sh — create or update the SIMWARS App Runner service.
#
# First run creates the service. Subsequent runs detect that it exists and
# trigger a fresh deployment (which pulls :latest from ECR).

source "$(dirname "$0")/env.sh"

ECR_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_ECR_ROLE}"
INSTANCE_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_INSTANCE_ROLE}"
IMAGE_URI="${ECR_URL}:latest"

# Look up service ARN
SERVICE_ARN=$(aws_run apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "${SERVICE_ARN}" ] || [ "${SERVICE_ARN}" = "None" ]; then
  echo "════════════════════════════════════════════════════════════"
  echo "  Creating App Runner service ${APP_RUNNER_SERVICE}"
  echo "════════════════════════════════════════════════════════════"

  # Build the runtime env block. Devnet on-chain knobs only get attached
  # when DEPLOYER_KEYPAIR_SECRET_ARN is set (i.e. the user has run
  # deploy-devnet.sh and pushed the keypair to Secrets Manager). Without
  # the ARN we ship in localnet mode and on-chain runs will fail at the
  # SDK layer — clean failure instead of half-configured devnet.
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

  CONFIG=$(cat <<EOF
{
  "ServiceName": "${APP_RUNNER_SERVICE}",
  "SourceConfiguration": {
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
    "AutoDeploymentsEnabled": true,
    "AuthenticationConfiguration": {
      "AccessRoleArn": "${ECR_ROLE_ARN}"
    }
  },
  "InstanceConfiguration": {
    "Cpu": "1 vCPU",
    "Memory": "2 GB",
    "InstanceRoleArn": "${INSTANCE_ROLE_ARN}"
  },
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

  aws_run apprunner create-service --cli-input-json "${CONFIG}"
  echo "  service creation kicked off (this takes ~5–10 min)"
else
  echo "════════════════════════════════════════════════════════════"
  echo "  Triggering deployment for ${APP_RUNNER_SERVICE}"
  echo "  (service ARN: ${SERVICE_ARN})"
  echo "════════════════════════════════════════════════════════════"
  aws_run apprunner start-deployment --service-arn "${SERVICE_ARN}"
  echo "  deployment kicked off"
  echo
  echo "  NOTE: start-deployment re-pulls the image but does NOT update env vars."
  echo "  If you added knobs to RuntimeEnvironmentVariables above, run:"
  echo "    aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner update-service \\"
  echo "      --service-arn \"${SERVICE_ARN}\" \\"
  echo "      --source-configuration '{\"ImageRepository\": {...}}'  # full ImageConfiguration block"
fi

echo
echo "Watch status:"
echo "  aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner describe-service \\"
echo "    --service-arn \"\$(aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner list-services --query \"ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]\" --output text)\" \\"
echo "    --query 'Service.[Status, ServiceUrl]' --output table"
