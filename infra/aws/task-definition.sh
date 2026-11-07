# Registers one task definition; prints its ARN. Sourced by deploy.sh.
# Usage: register_task FAMILY CPU MEMORY IMAGE 'COMMAND_JSON' SECRET_NAME...
register_task() {
  local family=$1 cpu=$2 memory=$3 image=$4 command=$5
  shift 5
  # Secrets are references (valueFrom, a Secrets Manager ARN: a bare name means SSM); ECS resolves
  # them at start, so no value is in the definition.
  local secrets name
  secrets=$(for name in "$@"; do
    jq -n --arg name "$name" --arg arn "$(secret_arn "$name")" '{name: $name, valueFrom: $arn}'
  done | jq -s .)
  jq -n --arg family "$family" --arg cpu "$cpu" --arg memory "$memory" --arg image "$image" \
    --argjson command "$command" --argjson secrets "$secrets" \
    --arg role "arn:aws:iam::$ACCOUNT_ID:role/$EXECUTION_ROLE" --arg logs "$LOG_GROUP" --arg region "$REGION" \
    --arg tk "$TAG_KEY" --arg tv "$TAG_VALUE" '{
    family: $family, networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
    cpu: $cpu, memory: $memory, executionRoleArn: $role,
    runtimePlatform: {cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX"},
    containerDefinitions: [{
      name: "app", image: $image, essential: true, command: $command,
      portMappings: (if $family == "trace-web" then [{containerPort: 3000, protocol: "tcp"}] else [] end),
      environment: [{name: "LOG_LEVEL", value: "info"}],
      secrets: $secrets,
      # tsx runs the worker in a child process; an init process forwards SIGTERM and reaps it.
      linuxParameters: {initProcessEnabled: true},
      stopTimeout: 30,
      logConfiguration: {logDriver: "awslogs", options: {
        "awslogs-group": $logs, "awslogs-region": $region, "awslogs-stream-prefix": $family}}}],
    tags: [{key: $tk, value: $tv}]}' >"$WORK/$family.json"
  awsc ecs register-task-definition --cli-input-json "file://$WORK/$family.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}
