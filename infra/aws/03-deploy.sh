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
          "SIM_DISABLE_ONCHAIN": "1",
          "SIM_API_PORT": "8787",
          "NEXT_PORT": "3000",
          "PUBLIC_PORT": "8080"
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
fi

echo
echo "Watch status:"
echo "  aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner describe-service \\"
echo "    --service-arn \"\$(aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner list-services --query \"ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]\" --output text)\" \\"
echo "    --query 'Service.[Status, ServiceUrl]' --output table"
