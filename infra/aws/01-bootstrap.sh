#!/usr/bin/env bash
# 01-bootstrap.sh — one-shot AWS resource bootstrap for SIMWARS.
#
# Idempotent: re-running is safe. Each step prints whether it created or
# reused an existing resource.
#
# Creates (in this order):
#   - Route 53 hosted zone for the domain
#   - ECR repository for the container image
#   - IAM role: AppRunnerECRAccessRoleSimwars (App Runner pulls from ECR)
#   - IAM role: AppRunnerInstanceRoleSimwars  (runtime permissions)

source "$(dirname "$0")/env.sh"

echo "════════════════════════════════════════════════════════════"
echo "  SIMWARS — AWS bootstrap (account=${AWS_ACCOUNT_ID}, region=${AWS_REGION})"
echo "════════════════════════════════════════════════════════════"

# 1. Route 53 hosted zone
echo
echo "── Route 53 hosted zone for ${DOMAIN} ──────────────────────"
ZONE_ID=$(aws_run route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN}." \
  --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" \
  --output text 2>/dev/null || true)

if [ -z "${ZONE_ID}" ] || [ "${ZONE_ID}" = "None" ]; then
  echo "creating hosted zone for ${DOMAIN}…"
  ZONE_ID=$(aws_run route53 create-hosted-zone \
    --name "${DOMAIN}" \
    --caller-reference "simwars-bootstrap-$(date +%s)" \
    --query 'HostedZone.Id' --output text)
  echo "  created: ${ZONE_ID}"
else
  ZONE_ID="${ZONE_ID#/hostedzone/}"
  echo "  reusing existing zone: ${ZONE_ID}"
fi
ZONE_ID="${ZONE_ID#/hostedzone/}"

echo
echo "Nameservers (paste these into Hostinger DNS panel):"
aws_run route53 get-hosted-zone --id "${ZONE_ID}" \
  --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sed 's/^/  /'

# 2. ECR repository
echo
echo "── ECR repository ${ECR_REPO} ──────────────────────────────"
if aws_run ecr describe-repositories --repository-names "${ECR_REPO}" >/dev/null 2>&1; then
  echo "  reusing existing repo: ${ECR_URL}"
else
  echo "creating ECR repo…"
  aws_run ecr create-repository \
    --repository-name "${ECR_REPO}" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability MUTABLE >/dev/null
  echo "  created: ${ECR_URL}"
fi

# 3. IAM role — App Runner ECR access
echo
echo "── IAM role ${APP_RUNNER_ECR_ROLE} ─────────────────────────"
if aws_run iam get-role --role-name "${APP_RUNNER_ECR_ROLE}" >/dev/null 2>&1; then
  echo "  reusing existing role"
else
  echo "creating role…"
  aws_run iam create-role \
    --role-name "${APP_RUNNER_ECR_ROLE}" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "build.apprunner.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  aws_run iam attach-role-policy \
    --role-name "${APP_RUNNER_ECR_ROLE}" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
  echo "  created"
fi

# 4. IAM role — App Runner instance (runtime)
echo
echo "── IAM role ${APP_RUNNER_INSTANCE_ROLE} ────────────────────"
if aws_run iam get-role --role-name "${APP_RUNNER_INSTANCE_ROLE}" >/dev/null 2>&1; then
  echo "  reusing existing role"
else
  echo "creating role…"
  aws_run iam create-role \
    --role-name "${APP_RUNNER_INSTANCE_ROLE}" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  echo "  created (no extra policies attached — BYOK means no Secrets Manager access yet)"
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  BOOTSTRAP COMPLETE"
echo
echo "  Zone ID:        ${ZONE_ID}"
echo "  ECR repository: ${ECR_URL}"
echo "  ECR role:       arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_ECR_ROLE}"
echo "  Instance role:  arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_RUNNER_INSTANCE_ROLE}"
echo
echo "  Next:"
echo "    1. Paste the nameservers above into Hostinger's DNS panel"
echo "       (Domains → simwars.xyz → DNS / Nameservers → Change nameservers)"
echo "    2. Wait ~5 min for propagation, then run:"
echo "         ./infra/aws/02-build-push.sh"
echo "         ./infra/aws/03-deploy.sh"
echo "         ./infra/aws/04-domain.sh"
echo "════════════════════════════════════════════════════════════"
