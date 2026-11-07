# Shared settings for the infra/aws scripts. Sourced, not run.
set -euo pipefail

# The trial account allows only this region (an organization SCP denies the others).
PROFILE=corgi
REGION=ap-southeast-2
awsc() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

ACCOUNT_ID=$(awsc sts get-caller-identity --query Account --output text)
ECR_REPO=trace
IMAGE_REPO="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"
CLUSTER=trace
LOG_GROUP=/ecs/trace
EXECUTION_ROLE=trace-ecs-execution
DB_ID=trace-db
DB_NAME=trace
DB_USER=trace
ALB_NAME=trace-alb
TARGET_GROUP=trace-web
SECRET_PREFIX=trace/
SECRETS=(DATABASE_URL SESSION_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET INCREASE_API_KEY INCREASE_WEBHOOK_SECRET)
TAG_KEY=project
TAG_VALUE=trace

VPC_ID=$(awsc ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
read -ra SUBNET_IDS <<<"$(awsc ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text)"
SUBNETS=$(IFS=,; echo "${SUBNET_IDS[*]}")

sg_id() {
  awsc ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$1" \
    --query 'SecurityGroups[0].GroupId' --output text
}

secret_arn() {
  awsc secretsmanager describe-secret --secret-id "$SECRET_PREFIX$1" --query ARN --output text
}
