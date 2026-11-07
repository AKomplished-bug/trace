#!/usr/bin/env bash
# Creates the AWS resources Trace runs on. Safe to re-run: each step finds what exists and skips it.
# Usage: ENV_FILE=path/to/.env infra/aws/bootstrap.sh   (reads STRIPE_SECRET_KEY from it once)
source "$(dirname "$0")/common.sh"

ENV_FILE=${ENV_FILE:-.env}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
TAGS="Key=$TAG_KEY,Value=$TAG_VALUE"
CLOUDFRONT_PREFIX_LIST=$(awsc ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
# Managed CloudFront policies: CachingDisabled, and AllViewer (every header including Host, cookies, query).
CACHE_POLICY_CACHING_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad
ORIGIN_REQUEST_POLICY_ALL_VIEWER=216adef6-5c7f-47e4-b989-5492eafa07d3

echo "== ECR repository"
if ! awsc ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then
  awsc ecr create-repository --repository-name "$ECR_REPO" --image-scanning-configuration scanOnPush=true \
    --tags "$TAGS" >/dev/null
fi
awsc ecr put-lifecycle-policy --repository-name "$ECR_REPO" --lifecycle-policy-text \
  '{"rules":[{"rulePriority":1,"description":"keep the last 10 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' >/dev/null

echo "== Log group"
if [ "$(awsc logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "length(logGroups[?logGroupName=='$LOG_GROUP'])")" = 0 ]; then
  awsc logs create-log-group --log-group-name "$LOG_GROUP" --tags "$TAG_KEY=$TAG_VALUE"
fi
awsc logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 7

echo "== Security groups"
ensure_sg() {
  local id
  id=$(sg_id "$1")
  if [ "$id" = None ]; then
    id=$(awsc ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC_ID" \
      --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  fi
  echo "$id"
}
allow_ingress() { # group-id, ip-permissions; an existing rule is fine
  awsc ec2 authorize-security-group-ingress --group-id "$1" --ip-permissions "$2" >/dev/null 2>"$WORK/err" ||
    grep -q InvalidPermission.Duplicate "$WORK/err" || { cat "$WORK/err" >&2; exit 1; }
}
ALB_SG=$(ensure_sg trace-alb "Trace ALB: HTTP from CloudFront only")
WEB_SG=$(ensure_sg trace-web "Trace web tasks: port 3000 from the ALB")
WORKER_SG=$(ensure_sg trace-worker "Trace worker and one-off tasks: no inbound")
DB_SG=$(ensure_sg trace-db "Trace Postgres: 5432 from web and worker tasks")
allow_ingress "$ALB_SG" "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$CLOUDFRONT_PREFIX_LIST}]"
allow_ingress "$WEB_SG" "IpProtocol=tcp,FromPort=3000,ToPort=3000,UserIdGroupPairs=[{GroupId=$ALB_SG}]"
allow_ingress "$DB_SG" "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$WEB_SG},{GroupId=$WORKER_SG}]"

echo "== Secrets"
# Values go through files in $WORK (mode 700), never through argv or output.
ensure_secret() { # name, file with the initial value; an existing secret keeps its value
  if ! awsc secretsmanager describe-secret --secret-id "$SECRET_PREFIX$1" >/dev/null 2>&1; then
    awsc secretsmanager create-secret --name "$SECRET_PREFIX$1" --secret-string "file://$2" --tags "$TAGS" >/dev/null
    echo "created $SECRET_PREFIX$1"
  fi
}
printf '%s' "$(openssl rand -hex 32)" >"$WORK/session"
ensure_secret SESSION_SECRET "$WORK/session"
if ! awsc secretsmanager describe-secret --secret-id "${SECRET_PREFIX}STRIPE_SECRET_KEY" >/dev/null 2>&1; then
  grep '^STRIPE_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]' >"$WORK/stripe"
  [ -s "$WORK/stripe" ] || { echo "STRIPE_SECRET_KEY not found in $ENV_FILE" >&2; exit 1; }
  ensure_secret STRIPE_SECRET_KEY "$WORK/stripe"
fi
# Placeholders until the real values exist: the app requires these variables to start. The random
# suffix keeps the Stripe placeholder from being a known signing key.
printf 'whsec_placeholder_%s' "$(openssl rand -hex 24)" >"$WORK/whsec"
ensure_secret STRIPE_WEBHOOK_SECRET "$WORK/whsec"
printf 'placeholder-increase-sandbox-not-configured' >"$WORK/increase-key"
ensure_secret INCREASE_API_KEY "$WORK/increase-key"
printf 'placeholder-increase-webhook-not-configured' >"$WORK/increase-whsec"
ensure_secret INCREASE_WEBHOOK_SECRET "$WORK/increase-whsec"

echo "== Execution role"
if ! awsc iam get-role --role-name "$EXECUTION_ROLE" >/dev/null 2>&1; then
  awsc iam create-role --role-name "$EXECUTION_ROLE" --tags "$TAGS" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}, "Action": "sts:AssumeRole"}]
  }' >/dev/null
fi
# Pull from ECR and write logs; attaching an attached policy is a no-op.
awsc iam attach-role-policy --role-name "$EXECUTION_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

echo "== Execution role can read the trace secrets"
awsc iam put-role-policy --role-name "$EXECUTION_ROLE" --policy-name trace-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\",
    \"Resource\": \"arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:${SECRET_PREFIX}*\"}]
}"

echo "== RDS Postgres"
if ! awsc rds describe-db-subnet-groups --db-subnet-group-name trace >/dev/null 2>&1; then
  awsc rds create-db-subnet-group --db-subnet-group-name trace --db-subnet-group-description "Trace default VPC subnets" \
    --subnet-ids "${SUBNET_IDS[@]}" --tags "$TAGS" >/dev/null
fi
# DATABASE_URL is the only copy of the master password. If it is missing, set a new password
# (on a new instance, or reset an existing one) and store the URL once the instance is available.
if ! awsc secretsmanager describe-secret --secret-id "${SECRET_PREFIX}DATABASE_URL" >/dev/null 2>&1; then
  DB_PASSWORD=$(openssl rand -hex 24)
  printf '%s' "$DB_PASSWORD" >"$WORK/dbpw" # jq reads it from the file, so it's never in argv
  if awsc rds describe-db-instances --db-instance-identifier "$DB_ID" >/dev/null 2>&1; then
    jq -n --arg id "$DB_ID" --rawfile pw "$WORK/dbpw" \
      '{DBInstanceIdentifier: $id, MasterUserPassword: $pw, ApplyImmediately: true}' >"$WORK/db.json"
    awsc rds modify-db-instance --cli-input-json "file://$WORK/db.json" >/dev/null
    sleep 30 # the reset takes a moment to start; wait below for it to finish
  else
    jq -n --arg id "$DB_ID" --rawfile pw "$WORK/dbpw" --arg db "$DB_NAME" --arg user "$DB_USER" --arg sg "$DB_SG" \
      --arg tk "$TAG_KEY" --arg tv "$TAG_VALUE" '{
        DBInstanceIdentifier: $id, DBInstanceClass: "db.t4g.micro", Engine: "postgres", EngineVersion: "16",
        DBName: $db, MasterUsername: $user, MasterUserPassword: $pw,
        AllocatedStorage: 20, StorageType: "gp3", StorageEncrypted: true,
        BackupRetentionPeriod: 0, MultiAZ: false, PubliclyAccessible: false,
        DBSubnetGroupName: "trace", VpcSecurityGroupIds: [$sg],
        Tags: [{Key: $tk, Value: $tv}]}' >"$WORK/db.json"
    awsc rds create-db-instance --cli-input-json "file://$WORK/db.json" >/dev/null
  fi
  echo "waiting for $DB_ID to be available (a new instance takes ~10 minutes)"
  awsc rds wait db-instance-available --db-instance-identifier "$DB_ID"
  DB_HOST=$(awsc rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
  # verify-full: the image trusts the RDS CA bundle (Dockerfile).
  printf 'postgres://%s:%s@%s:5432/%s?sslmode=verify-full' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_NAME" >"$WORK/dburl"
  ensure_secret DATABASE_URL "$WORK/dburl"
fi

echo "== Load balancer"
ALB_ARN=$(awsc elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null) ||
  ALB_ARN=$(awsc elbv2 create-load-balancer --name "$ALB_NAME" --type application --scheme internet-facing \
    --subnets "${SUBNET_IDS[@]}" --security-groups "$ALB_SG" --tags "$TAGS" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
TG_ARN=$(awsc elbv2 describe-target-groups --names "$TARGET_GROUP" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null) ||
  TG_ARN=$(awsc elbv2 create-target-group --name "$TARGET_GROUP" --protocol HTTP --port 3000 --vpc-id "$VPC_ID" \
    --target-type ip --health-check-path /api/health --health-check-interval-seconds 15 --healthy-threshold-count 2 \
    --matcher HttpCode=200 --tags "$TAGS" --query 'TargetGroups[0].TargetGroupArn' --output text)
awsc elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
if [ "$(awsc elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'length(Listeners)')" = 0 ]; then
  awsc elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" --tags "$TAGS" >/dev/null
fi
ALB_DNS=$(awsc elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)

echo "== ECS cluster"
# A new account has no ECS service-linked role until something creates it.
awsc iam get-role --role-name AWSServiceRoleForECS >/dev/null 2>&1 ||
  awsc iam create-service-linked-role --aws-service-name ecs.amazonaws.com >/dev/null
awsc ecs create-cluster --cluster-name "$CLUSTER" --capacity-providers FARGATE \
  --tags "key=$TAG_KEY,value=$TAG_VALUE" >/dev/null

echo "== CloudFront"
DIST_ID=$(awsc cloudfront list-distributions --query "DistributionList.Items[?Comment=='trace'].Id | [0]" --output text)
if [ "$DIST_ID" = None ]; then
  # Host is forwarded so the app sees the CloudFront host, which the browser's Origin header names
  # (checkSameOrigin compares the two). The body and Stripe-Signature pass through unchanged.
  jq -n --arg alb "$ALB_DNS" --arg cp "$CACHE_POLICY_CACHING_DISABLED" --arg orp "$ORIGIN_REQUEST_POLICY_ALL_VIEWER" \
    --arg tk "$TAG_KEY" --arg tv "$TAG_VALUE" '{
    DistributionConfig: {
      CallerReference: "trace-web", Comment: "trace", Enabled: true, PriceClass: "PriceClass_100", HttpVersion: "http2",
      Origins: {Quantity: 1, Items: [{Id: "alb", DomainName: $alb,
        CustomOriginConfig: {HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "http-only",
          OriginReadTimeout: 30, OriginKeepaliveTimeout: 5,
          OriginSslProtocols: {Quantity: 1, Items: ["TLSv1.2"]}}}]},
      DefaultCacheBehavior: {TargetOriginId: "alb", ViewerProtocolPolicy: "redirect-to-https", Compress: false,
        CachePolicyId: $cp, OriginRequestPolicyId: $orp,
        AllowedMethods: {Quantity: 7, Items: ["GET","HEAD","OPTIONS","PUT","PATCH","POST","DELETE"],
          CachedMethods: {Quantity: 2, Items: ["GET","HEAD"]}}}},
    Tags: {Items: [{Key: $tk, Value: $tv}]}}' >"$WORK/cf.json"
  DIST_ID=$(awsc cloudfront create-distribution-with-tags --distribution-config-with-tags "file://$WORK/cf.json" \
    --query 'Distribution.Id' --output text)
fi
CF_DOMAIN=$(awsc cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)

echo "== Budget"
BUDGET_EMAIL=athulkrishna8781@gmail.com
if ! awsc budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name trace-monthly >/dev/null 2>&1; then
  jq -n '{BudgetName: "trace-monthly", BudgetType: "COST", TimeUnit: "MONTHLY",
    BudgetLimit: {Amount: "60", Unit: "USD"}}' >"$WORK/budget.json"
  jq -n --arg email "$BUDGET_EMAIL" '[50, 80, 100] | map({
    Notification: {NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: ., ThresholdType: "PERCENTAGE"},
    Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]})' >"$WORK/notifications.json"
  awsc budgets create-budget --account-id "$ACCOUNT_ID" --budget "file://$WORK/budget.json" \
    --notifications-with-subscribers "file://$WORK/notifications.json" \
    --resource-tags "$TAGS" || echo "budget not created (see the error above)"
fi

echo
echo "ALB:        $ALB_DNS"
echo "CloudFront: https://$CF_DOMAIN  ($DIST_ID)"
echo "Next: infra/aws/deploy.sh, then once: infra/aws/run-task.sh seed"
