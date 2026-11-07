#!/usr/bin/env bash
# Builds the image from the current commit, pushes it, runs migrations, then rolls both services.
# Usage: infra/aws/deploy.sh   (from a clean checkout; run bootstrap.sh first)
source "$(dirname "$0")/common.sh"
source "$(dirname "$0")/task-definition.sh"
cd "$(git rev-parse --show-toplevel)"

[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first: the image is tagged by commit" >&2; exit 1; }
TAG=$(git rev-parse --short HEAD)
IMAGE="$IMAGE_REPO:$TAG"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "== Build and push $IMAGE"
awsc ecr get-login-password | docker login --username AWS --password-stdin "${IMAGE_REPO%%/*}" >/dev/null
docker build --platform linux/arm64 -t "$IMAGE" .
docker push "$IMAGE" >/dev/null

echo "== Task definitions"
APP_SECRETS=("${SECRETS[@]}")
WEB_TD=$(register_task trace-web 256 1024 "$IMAGE" '["node_modules/.bin/next","start","--port","3000"]' "${APP_SECRETS[@]}")
# tsx as a loader, not the CLI, so the worker is the process that gets SIGTERM.
WORKER_TD=$(register_task trace-worker 256 512 "$IMAGE" '["node","--import","tsx","src/worker/index.ts"]' "${APP_SECRETS[@]}")
# Migrate and seed read DATABASE_URL, seed the users' passwords (only this task gets them), and the
# Increase bootstrap INCREASE_API_KEY (its entity is the sandbox's only active one); run-task.sh
# overrides the command.
register_task trace-migrate 256 512 "$IMAGE" '["node_modules/.bin/tsx","scripts/migrate.ts"]' \
  DATABASE_URL TRACE_OWNER_PASSWORD TRACE_OPS_PASSWORD INCREASE_API_KEY >/dev/null

echo "== Migrate"
"$(dirname "$0")/run-task.sh" migrate

echo "== Services"
NETWORK="awsvpcConfiguration={subnets=[$SUBNETS],assignPublicIp=ENABLED,securityGroups=[%s]}"
TG_ARN=$(awsc elbv2 describe-target-groups --names "$TARGET_GROUP" --query 'TargetGroups[0].TargetGroupArn' --output text)
ensure_service() { # name, task definition, security group, extra create-service args...
  local name=$1 td=$2 sg=$3
  shift 3
  if [ "$(awsc ecs describe-services --cluster "$CLUSTER" --services "$name" --query 'services[0].status' --output text)" = ACTIVE ]; then
    awsc ecs update-service --cluster "$CLUSTER" --service "$name" --task-definition "$td" >/dev/null
  else
    # shellcheck disable=SC2059
    awsc ecs create-service --cluster "$CLUSTER" --service-name "$name" --task-definition "$td" --desired-count 1 \
      --launch-type FARGATE --network-configuration "$(printf "$NETWORK" "$sg")" \
      --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true}' \
      --propagate-tags SERVICE --tags "key=$TAG_KEY,value=$TAG_VALUE" "$@" >/dev/null
  fi
}
ensure_service trace-web "$WEB_TD" "$(sg_id trace-web)" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=app,containerPort=3000" --health-check-grace-period-seconds 30
ensure_service trace-worker "$WORKER_TD" "$(sg_id trace-worker)"
echo "waiting for both services to be stable"
awsc ecs wait services-stable --cluster "$CLUSTER" --services trace-web trace-worker
echo "deployed $TAG"
