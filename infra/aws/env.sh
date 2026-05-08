# Shared variables for the SIMWARS AWS deploy scripts.
# Source this from the other scripts: `source "$(dirname "$0")/env.sh"`.

# AWS context
export AWS_PROFILE="${AWS_PROFILE:-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
# Required — set in your shell or pass inline so the account id stays out of the repo:
#   AWS_ACCOUNT_ID=123456789012 bash infra/aws/01-bootstrap.sh
# Or add to ~/.zshrc:  export AWS_ACCOUNT_ID=123456789012
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID before running these scripts (e.g. in your shell profile)}"

# Domain / DNS
export DOMAIN="${DOMAIN:-simwars.xyz}"

# ECR
export ECR_REPO="${ECR_REPO:-simwars}"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
export ECR_URL="${ECR_REGISTRY}/${ECR_REPO}"

# App Runner
export APP_RUNNER_SERVICE="${APP_RUNNER_SERVICE:-simwars-web}"
export APP_RUNNER_INSTANCE_ROLE="${APP_RUNNER_INSTANCE_ROLE:-AppRunnerInstanceRoleSimwars}"
export APP_RUNNER_ECR_ROLE="${APP_RUNNER_ECR_ROLE:-AppRunnerECRAccessRoleSimwars}"

# Sanity check
if [ "$AWS_PROFILE" != "dev" ]; then
  echo "[env.sh] WARN: AWS_PROFILE is '$AWS_PROFILE' (expected 'dev' for this account)"
fi

aws_run() {
  aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}

# Optional secret ARN for the Solana deployer keypair. When set, 03-deploy.sh
# wires this through to the App Runner runtime env so entrypoint.sh fetches
# the keypair at boot. Empty by default — the local-only / on-chain-disabled
# path doesn't need it. Populate after running infra/onchain/deploy-devnet.sh
# and `aws secretsmanager create-secret --name simwars/deployer-keypair …`.
export DEPLOYER_KEYPAIR_SECRET_ARN="${DEPLOYER_KEYPAIR_SECRET_ARN:-}"

# Standard error handling for scripts that source this file.
set -euo pipefail
