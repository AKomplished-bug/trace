#!/usr/bin/env bash
# Runs a one-off task on the latest trace-migrate definition and waits for its exit code.
# Usage: infra/aws/run-task.sh migrate|seed
source "$(dirname "$0")/common.sh"

case "${1:-}" in
  migrate) SCRIPT=scripts/migrate.ts ;;
  seed) SCRIPT=scripts/seed.ts ;; # idempotent base seed; db:seed:demo is dev-only and refuses production
  *) echo "usage: $0 migrate|seed" >&2; exit 2 ;;
esac

TASK_ARN=$(awsc ecs run-task --cluster "$CLUSTER" --task-definition trace-migrate --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$(sg_id trace-worker)],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"app\",\"command\":[\"node_modules/.bin/tsx\",\"$SCRIPT\"]}]}" \
  --tags "key=$TAG_KEY,value=$TAG_VALUE" --query 'tasks[0].taskArn' --output text)
echo "$1: $TASK_ARN"
awsc ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE=$(awsc ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)
awsc logs tail "$LOG_GROUP" --log-stream-name-prefix "trace-migrate/app/${TASK_ARN##*/}" --since 30m --format short || true
if [ "$EXIT_CODE" != 0 ]; then
  echo "$1 failed (exit code $EXIT_CODE; stopped reason: $(awsc ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].stoppedReason' --output text))" >&2
  exit 1
fi
