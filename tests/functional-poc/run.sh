#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
MYSQL_CONTAINER="docklane-poc-mysql"
REGISTRY_CONTAINER="docklane-poc-registry"
SERVICE_NAME="docklane-poc"
REGISTRY="127.0.0.1:5000"
IMAGE_REPO="$REGISTRY/docklane-poc"
API_URL="http://127.0.0.1:3001"
AGENT_BACKEND_URL="http://127.0.0.1:9443"
AGENT_URL="http://127.0.0.1:9555"
HEALTH_URL="http://127.0.0.1:18080"
OPERATOR_TOKEN="docklane-poc-operator-00000001"
VIEWER_TOKEN="docklane-poc-viewer-0000000001"

export DOCKLANE_POC_LOG_DIR="$LOG_DIR"

cleanup() {
  bash "$ROOT_DIR/tests/functional-poc/cleanup.sh" || true
}

log() {
  printf '[functional-poc] %s\n' "$*"
}

fail() {
  printf '[functional-poc] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

wait_http() {
  local url="$1"
  local expected="${2:-200}"
  local attempts="${3:-90}"

  for ((i = 1; i <= attempts; i++)); do
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done

  fail "timed out waiting for $url (expected HTTP $expected)"
}

wait_for_body() {
  local url="$1"
  local expected="$2"

  for _ in {1..90}; do
    local body
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [[ "$body" == *"$expected"* ]]; then
      return 0
    fi
    sleep 1
  done

  fail "timed out waiting for body '$expected' from $url"
}

api_post() {
  local path="$1"
  local body="$2"
  curl -fsS     -X POST     -H "Authorization: Bearer $OPERATOR_TOKEN"     -H 'Content-Type: application/json'     --data "$body"     "$API_URL$path"
}

api_get() {
  local path="$1"
  curl -fsS     -H "Authorization: Bearer $OPERATOR_TOKEN"     "$API_URL$path"
}

wait_deployment_terminal() {
  local deployment_id="$1"
  local expected="$2"
  local output_file="$3"
  local attempts="${4:-120}"

  for ((i = 1; i <= attempts; i++)); do
    local status_json
    status_json="$(api_get "/v1/clusters/default/deployments/$deployment_id/status")"
    printf '%s\n' "$status_json" >"$output_file"

    local status
    status="$(jq -er '.deployment.status' <<<"$status_json")"

    case "$status" in
      "$expected")
        jq -c '.deployment' <<<"$status_json"
        return 0
        ;;
      SUCCESS|FAILED|ROLLED_BACK|ROLLBACK_FAILED|NEEDS_ATTENTION)
        fail "deployment $deployment_id reached terminal status $status; expected $expected"
        ;;
    esac

    sleep 1
  done

  fail "timed out waiting for deployment $deployment_id to reach $expected"
}

assert_image_mutation_count() {
  local digest="$1"
  local expected="$2"
  local label="$3"
  local log_file="$LOG_DIR/agent-image-mutations.jsonl"
  local count=0

  if [[ -s "$log_file" ]]; then
    count="$(jq -s       --arg digest "$digest"       '[.[] | select(.event == "forwarded" and ((.image // "") | endswith("@" + $digest)))] | length'       "$log_file")"
  fi

  if [[ "$count" != "$expected" ]]; then
    fail "$label forwarded image mutation count=$count; expected=$expected for digest=$digest"
  fi
}

require_command docker
require_command curl
require_command jq
require_command pnpm
require_command go

preflight_absent_container() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    fail "functional PoC refuses to start because container already exists: $name"
  fi
}

preflight_absent_service() {
  local name="$1"
  if docker service inspect "$name" >/dev/null 2>&1; then
    fail "functional PoC refuses to start because service already exists: $name"
  fi
}

if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "inactive" ]]; then
  fail "functional PoC requires a disposable Docker host with Swarm inactive"
fi

preflight_absent_container "$REGISTRY_CONTAINER"
preflight_absent_container "$MYSQL_CONTAINER"
preflight_absent_service "$SERVICE_NAME"

mkdir -p "$LOG_DIR"
rm -rf "$OWNERSHIP_DIR"
mkdir -p "$OWNERSHIP_DIR"
trap cleanup EXIT

log "starting local OCI registry"
REGISTRY_CONTAINER_ID="$(docker run -d   --name "$REGISTRY_CONTAINER"   -p 5000:5000   registry:2)"
printf '%s\n' "$REGISTRY_CONTAINER_ID" >"$LOG_DIR/registry.container"
printf '%s\n' "$REGISTRY_CONTAINER_ID" >"$OWNERSHIP_DIR/registry.container-id"

wait_http "http://127.0.0.1:5000/v2/" 200 60

log "starting MySQL"
MYSQL_CONTAINER_ID="$(docker run -d   --name "$MYSQL_CONTAINER"   -e MYSQL_ROOT_PASSWORD=docklane   -e MYSQL_DATABASE=docklane   -p 33306:3306   mysql:8.4)"
printf '%s\n' "$MYSQL_CONTAINER_ID" >"$LOG_DIR/mysql.container"
printf '%s\n' "$MYSQL_CONTAINER_ID" >"$OWNERSHIP_DIR/mysql.container-id"

for _ in {1..90}; do
  if docker exec "$MYSQL_CONTAINER"     mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$MYSQL_CONTAINER"   mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1   || fail "MySQL did not become ready"

log "building and pushing v1/v2/v3/v4/v5/broken fixture images"
docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v1   -t "$IMAGE_REPO:v1"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v1.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v2   -t "$IMAGE_REPO:v2"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v2.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v3   --build-arg START_DELAY=8   -t "$IMAGE_REPO:v3"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v3.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v4   -t "$IMAGE_REPO:v4"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v4.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v5   -t "$IMAGE_REPO:v5"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v5.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=vbroken   --build-arg HEALTH_STATUS=503   -t "$IMAGE_REPO:vbroken"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-vbroken.log"

docker push "$IMAGE_REPO:v1" >"$LOG_DIR/docker-push-v1.log"
docker push "$IMAGE_REPO:v2" >"$LOG_DIR/docker-push-v2.log"
docker push "$IMAGE_REPO:v3" >"$LOG_DIR/docker-push-v3.log"
docker push "$IMAGE_REPO:v4" >"$LOG_DIR/docker-push-v4.log"
docker push "$IMAGE_REPO:v5" >"$LOG_DIR/docker-push-v5.log"
docker push "$IMAGE_REPO:vbroken" >"$LOG_DIR/docker-push-vbroken.log"

SWARM_ADDR="$(hostname -I | awk '{print $1}')"
[[ -n "$SWARM_ADDR" ]] || fail "could not determine Swarm advertise address"

log "initializing single-node Swarm at $SWARM_ADDR"
docker swarm init --advertise-addr "$SWARM_ADDR" >"$LOG_DIR/swarm-init.log"
SWARM_NODE_ID="$(docker info --format '{{.Swarm.NodeID}}')"
[[ -n "$SWARM_NODE_ID" ]] || fail "could not record owned Swarm node ID"
printf '%s\n' "$SWARM_NODE_ID" >"$OWNERSHIP_DIR/swarm.node-id"

log "creating initial replicated service"
SERVICE_ID="$(docker service create   --quiet   --name "$SERVICE_NAME"   --replicas 1   --publish published=18080,target=8080   --update-order start-first   --update-parallelism 1   --reserve-cpu 0.05   --reserve-memory 16M   "$IMAGE_REPO:v1")"
printf '%s\n' "$SERVICE_ID" >"$LOG_DIR/service-create.log"
printf '%s\n' "$SERVICE_ID" >"$OWNERSHIP_DIR/service.id"

wait_for_body "$HEALTH_URL" "v1"

SERVICE_ID="$(docker service inspect "$SERVICE_ID" --format '{{.ID}}')"
[[ -n "$SERVICE_ID" ]] || fail "could not resolve service ID"

log "building Docklane API and Agent"
(
  cd "$ROOT_DIR/agent"
  go build -o bin/docklane-agent ./cmd/docklane-agent
)
(
  cd "$ROOT_DIR"
  pnpm --filter @docklane/api build
)

log "starting Go Agent"
(
  export DOCKLANE_AGENT_INSECURE_DEV=true
  export DOCKLANE_AGENT_ADDR=127.0.0.1:9443
  exec "$ROOT_DIR/agent/bin/docklane-agent"
) >"$LOG_DIR/agent.log" 2>&1 &
echo "$!" >"$LOG_DIR/agent.pid"
cp "$LOG_DIR/agent.pid" "$OWNERSHIP_DIR/agent.pid"

wait_http "$AGENT_BACKEND_URL/v1/health" 200 60

log "starting Agent response-loss proxy"
(
  export DOCKLANE_POC_AGENT_BACKEND_HOST=127.0.0.1
  export DOCKLANE_POC_AGENT_BACKEND_PORT=9443
  export DOCKLANE_POC_AGENT_DROP_MARKER="$LOG_DIR/drop-agent-image-response"
  export DOCKLANE_POC_AGENT_DROP_LOG="$LOG_DIR/agent-proxy-drops.log"
  export DOCKLANE_POC_AGENT_MUTATION_LOG="$LOG_DIR/agent-image-mutations.jsonl"
  exec python3 "$ROOT_DIR/tests/functional-poc/agent-proxy.py"
) >"$LOG_DIR/agent-proxy.log" 2>&1 &
echo "$!" >"$LOG_DIR/agent-proxy.pid"
cp "$LOG_DIR/agent-proxy.pid" "$OWNERSHIP_DIR/agent-proxy.pid"

wait_http "$AGENT_URL/v1/health" 200 60
: >"$LOG_DIR/agent-image-mutations.jsonl"

TOKENS_JSON="$(jq -cn   --arg operator "$OPERATOR_TOKEN"   --arg viewer "$VIEWER_TOKEN"   '[
    {
      token: $operator,
      actorId: "functional-poc-operator",
      role: "OPERATOR",
      clusters: ["default"]
    },
    {
      token: $viewer,
      actorId: "functional-poc-viewer",
      role: "VIEWER",
      clusters: ["default"]
    }
  ]')"

start_api() {
  local mode="${1:-truncate}"
  local redirect=">"

  if [[ "$mode" == "append" ]]; then
    redirect=">>"
  fi

  if [[ -f "$LOG_DIR/api.pid" ]]; then
    local existing
    existing="$(cat "$LOG_DIR/api.pid" 2>/dev/null || true)"
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      fail "API is already running with pid $existing"
    fi
  fi

  if [[ "$redirect" == ">>" ]]; then
    printf '\n===== API RESTART =====\n' >>"$LOG_DIR/api.log"
    (
      export PORT=3001
      export DOCKLANE_CLUSTER_ID=default
      export DOCKLANE_DATABASE_URL='mysql://root:docklane@127.0.0.1:33306/docklane'
      export DOCKLANE_AGENT_INSECURE_DEV=true
      export DOCKLANE_AGENT_URL="$AGENT_URL"
      export DOCKLANE_API_TOKENS="$TOKENS_JSON"
      export DOCKLANE_REGISTRY_PRIVATE_HOSTS="$REGISTRY"
      export DOCKLANE_REGISTRY_AUTH_JSON='{}'
      export DOCKLANE_HEALTH_PRIVATE_HOSTS='127.0.0.1:18080'
      exec node "$ROOT_DIR/apps/api/dist/main.js"
    ) >>"$LOG_DIR/api.log" 2>&1 &
  else
    (
      export PORT=3001
      export DOCKLANE_CLUSTER_ID=default
      export DOCKLANE_DATABASE_URL='mysql://root:docklane@127.0.0.1:33306/docklane'
      export DOCKLANE_AGENT_INSECURE_DEV=true
      export DOCKLANE_AGENT_URL="$AGENT_URL"
      export DOCKLANE_API_TOKENS="$TOKENS_JSON"
      export DOCKLANE_REGISTRY_PRIVATE_HOSTS="$REGISTRY"
      export DOCKLANE_REGISTRY_AUTH_JSON='{}'
      export DOCKLANE_HEALTH_PRIVATE_HOSTS='127.0.0.1:18080'
      exec node "$ROOT_DIR/apps/api/dist/main.js"
    ) >"$LOG_DIR/api.log" 2>&1 &
  fi

  echo "$!" >"$LOG_DIR/api.pid"
  cp "$LOG_DIR/api.pid" "$OWNERSHIP_DIR/api.pid"
}

crash_api() {
  local pid
  pid="$(cat "$LOG_DIR/api.pid")"
  kill -9 "$pid"
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$LOG_DIR/api.pid" "$OWNERSHIP_DIR/api.pid"
      return 0
    fi
    sleep 0.25
  done
  fail "API process $pid did not stop after SIGKILL"
}

log "starting Nest API"
start_api truncate

wait_http "$API_URL/health" 200 90

log "scenario: authorization rejection"
AUTH_CODE="$(curl -sS   -o "$LOG_DIR/auth-rejection.json"   -w '%{http_code}'   -X POST   -H "Authorization: Bearer $VIEWER_TOKEN"   -H 'Content-Type: application/json'   --data '{"name":"forbidden-app"}'   "$API_URL/v1/applications")"
[[ "$AUTH_CODE" == "403" ]]   || fail "VIEWER create application expected 403, got $AUTH_CODE"

log "creating Application"
APP_JSON="$(api_post   '/v1/applications'   '{"name":"functional-poc","description":"Docklane single-node functional PoC"}')"
printf '%s\n' "$APP_JSON" >"$LOG_DIR/application.json"
APP_ID="$(jq -er '.id' <<<"$APP_JSON")"

log "creating DeploymentTarget"
TARGET_JSON="$(api_post   "/v1/clusters/default/applications/$APP_ID/targets"   "$(jq -cn     --arg serviceId "$SERVICE_ID"     '{
      environment: "poc",
      dockerServiceId: $serviceId,
      serviceName: "docklane-poc",
      routingMode: "INGRESS"
    }')")"
printf '%s\n' "$TARGET_JSON" >"$LOG_DIR/target.json"
TARGET_ID="$(jq -er '.id' <<<"$TARGET_JSON")"

log "creating Release by tag (registry resolves immutable digest)"
RELEASE_JSON="$(api_post   "/v1/applications/$APP_ID/releases"   '{
    "version":"v2",
    "imageRepository":"http://127.0.0.1:5000/docklane-poc",
    "imageTag":"v2",
    "gitCommit":"functional-poc",
    "buildNumber":"manual-smoke"
  }')"
printf '%s\n' "$RELEASE_JSON" >"$LOG_DIR/release.json"
RELEASE_ID="$(jq -er '.id' <<<"$RELEASE_JSON")"
RELEASE_DIGEST="$(jq -er '.imageDigest' <<<"$RELEASE_JSON")"
[[ "$RELEASE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]   || fail "Release did not persist a sha256 digest: $RELEASE_DIGEST"

HEALTH_JSON='{
  "url":"http://127.0.0.1:18080/health",
  "intervalMs":100,
  "timeoutMs":1000,
  "retries":3,
  "stabilityWindowMs":500,
  "expectedStatus":200
}'

log "scenario: normal digest deployment"
DEPLOY_JSON="$(api_post   "/v1/clusters/default/targets/$TARGET_ID/deploy"   "$(jq -cn     --arg releaseId "$RELEASE_ID"     --argjson health "$HEALTH_JSON"     '{
      operationId: "functional-poc-deploy-v2",
      releaseId: $releaseId,
      health: $health
    }')")"
printf '%s\n' "$DEPLOY_JSON" >"$LOG_DIR/deploy-initial.json"
DEPLOYMENT_ID="$(jq -er '.id' <<<"$DEPLOY_JSON")"
DEPLOY_JSON="$(wait_deployment_terminal "$DEPLOYMENT_ID" SUCCESS "$LOG_DIR/deploy-status.json")"
printf '%s\n' "$DEPLOY_JSON" >"$LOG_DIR/deploy.json"
jq -e '.status == "SUCCESS" and .noOp == false' <<<"$DEPLOY_JSON" >/dev/null   || fail "normal deploy did not finish SUCCESS"

wait_for_body "$HEALTH_URL" "v2"

SERVICE_JSON="$(api_get "/v1/clusters/default/services/$SERVICE_ID")"
printf '%s\n' "$SERVICE_JSON" >"$LOG_DIR/service-after-deploy.json"
jq -e --arg digest "$RELEASE_DIGEST"   '.service.image | contains("@" + $digest)'   <<<"$SERVICE_JSON" >/dev/null   || fail "service image is not pinned to release digest"

log "scenario: same digest/spec no-op redeploy"
NOOP_JSON="$(api_post   "/v1/clusters/default/targets/$TARGET_ID/deploy"   "$(jq -cn     --arg releaseId "$RELEASE_ID"     --argjson health "$HEALTH_JSON"     '{
      operationId: "functional-poc-deploy-v2-noop",
      releaseId: $releaseId,
      health: $health
    }')")"
printf '%s\n' "$NOOP_JSON" >"$LOG_DIR/noop-deploy-initial.json"
NOOP_DEPLOYMENT_ID="$(jq -er '.id' <<<"$NOOP_JSON")"
NOOP_JSON="$(wait_deployment_terminal "$NOOP_DEPLOYMENT_ID" SUCCESS "$LOG_DIR/noop-deploy-status.json")"
printf '%s\n' "$NOOP_JSON" >"$LOG_DIR/noop-deploy.json"
jq -e '.status == "SUCCESS" and .noOp == true' <<<"$NOOP_JSON" >/dev/null   || fail "same digest/spec redeploy was not verified as no-op SUCCESS"

log "scenario: broken release deployment"
BROKEN_RELEASE_JSON="$(api_post   "/v1/applications/$APP_ID/releases"   '{
    "version":"vbroken",
    "imageRepository":"http://127.0.0.1:5000/docklane-poc",
    "imageTag":"vbroken",
    "gitCommit":"functional-poc-broken",
    "buildNumber":"manual-smoke-broken"
  }')"
printf '%s\n' "$BROKEN_RELEASE_JSON" >"$LOG_DIR/broken-release.json"
BROKEN_RELEASE_ID="$(jq -er '.id' <<<"$BROKEN_RELEASE_JSON")"
BROKEN_DIGEST="$(jq -er '.imageDigest' <<<"$BROKEN_RELEASE_JSON")"

BROKEN_DEPLOY_JSON="$(api_post   "/v1/clusters/default/targets/$TARGET_ID/deploy"   "$(jq -cn     --arg releaseId "$BROKEN_RELEASE_ID"     --argjson health "$HEALTH_JSON"     '{
      operationId: "functional-poc-deploy-broken",
      releaseId: $releaseId,
      health: $health
    }')")"
printf '%s\n' "$BROKEN_DEPLOY_JSON" >"$LOG_DIR/broken-deploy-initial.json"
BROKEN_DEPLOYMENT_ID="$(jq -er '.id' <<<"$BROKEN_DEPLOY_JSON")"
BROKEN_DEPLOY_JSON="$(wait_deployment_terminal "$BROKEN_DEPLOYMENT_ID" FAILED "$LOG_DIR/broken-deploy-status.json")"
printf '%s\n' "$BROKEN_DEPLOY_JSON" >"$LOG_DIR/broken-deploy.json"
jq -e '.status == "FAILED"' <<<"$BROKEN_DEPLOY_JSON" >/dev/null   || fail "broken release did not finish FAILED"

BROKEN_SERVICE_JSON="$(api_get "/v1/clusters/default/services/$SERVICE_ID")"
printf '%s\n' "$BROKEN_SERVICE_JSON" >"$LOG_DIR/service-after-broken-deploy.json"
jq -e --arg digest "$BROKEN_DIGEST"   '.service.image | contains("@" + $digest)'   <<<"$BROKEN_SERVICE_JSON" >/dev/null   || fail "broken service was not updated to the broken release digest"

log "scenario: manual rollback recovery"
ROLLBACK_JSON="$(api_post   "/v1/clusters/default/deployments/$BROKEN_DEPLOYMENT_ID/rollback"   '{"operationId":"functional-poc-rollback-broken"}')"
printf '%s\n' "$ROLLBACK_JSON" >"$LOG_DIR/rollback-initial.json"
ROLLBACK_JSON="$(wait_deployment_terminal "$BROKEN_DEPLOYMENT_ID" ROLLED_BACK "$LOG_DIR/rollback-status.json")"
printf '%s\n' "$ROLLBACK_JSON" >"$LOG_DIR/rollback.json"
jq -e '.status == "ROLLED_BACK"' <<<"$ROLLBACK_JSON" >/dev/null   || fail "manual rollback did not finish ROLLED_BACK"

wait_for_body "$HEALTH_URL" "v2"
wait_http "$HEALTH_URL/health" 200 60

ROLLED_BACK_SERVICE_JSON="$(api_get "/v1/clusters/default/services/$SERVICE_ID")"
printf '%s\n' "$ROLLED_BACK_SERVICE_JSON" >"$LOG_DIR/service-after-rollback.json"
jq -e --arg digest "$RELEASE_DIGEST"   '.service.image | contains("@" + $digest)'   <<<"$ROLLED_BACK_SERVICE_JSON" >/dev/null   || fail "rollback did not restore the previous release digest"

log "scenario: API restart during deployment verification"
RESTART_RELEASE_JSON="$(api_post   "/v1/applications/$APP_ID/releases"   '{
    "version":"v3",
    "imageRepository":"http://127.0.0.1:5000/docklane-poc",
    "imageTag":"v3",
    "gitCommit":"functional-poc-restart",
    "buildNumber":"manual-smoke-restart"
  }')"
printf '%s\n' "$RESTART_RELEASE_JSON" >"$LOG_DIR/restart-release.json"
RESTART_RELEASE_ID="$(jq -er '.id' <<<"$RESTART_RELEASE_JSON")"
RESTART_DIGEST="$(jq -er '.imageDigest' <<<"$RESTART_RELEASE_JSON")"

RESTART_HEALTH_JSON='{
  "url":"http://127.0.0.1:18080/health",
  "intervalMs":250,
  "timeoutMs":1000,
  "retries":10,
  "stabilityWindowMs":10000,
  "expectedStatus":200
}'

RESTART_OPERATION_ID="functional-poc-deploy-restart"
(
  curl -sS     -X POST     -H "Authorization: Bearer $OPERATOR_TOKEN"     -H 'Content-Type: application/json'     --data "$(jq -cn       --arg releaseId "$RESTART_RELEASE_ID"       --argjson health "$RESTART_HEALTH_JSON"       --arg operationId "$RESTART_OPERATION_ID"       '{
        operationId: $operationId,
        releaseId: $releaseId,
        health: $health
      }')"     "$API_URL/v1/clusters/default/targets/$TARGET_ID/deploy"     >"$LOG_DIR/restart-deploy-post.json"     2>"$LOG_DIR/restart-deploy-post.err" || true
) &
RESTART_REQUEST_PID="$!"

RESTART_DEPLOYMENT_ID=""
RESTART_OPERATION_STATUS=""
for _ in {1..120}; do
  RESTART_OPERATION_STATUS="$(docker exec "$MYSQL_CONTAINER"     mysql -uroot -pdocklane docklane     --batch --skip-column-names     -e "SELECT status FROM operations WHERE id = '$RESTART_OPERATION_ID' LIMIT 1"     2>/dev/null || true)"
  RESTART_DEPLOYMENT_ID="$(docker exec "$MYSQL_CONTAINER"     mysql -uroot -pdocklane docklane     --batch --skip-column-names     -e "SELECT id FROM deployments WHERE operation_id = '$RESTART_OPERATION_ID' LIMIT 1"     2>/dev/null || true)"
  CURRENT_IMAGE="$(docker service inspect "$SERVICE_NAME" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"

  if [[ -n "$RESTART_DEPLOYMENT_ID" ]] &&
     [[ "$RESTART_OPERATION_STATUS" == "RUNNING" || "$RESTART_OPERATION_STATUS" == "VERIFYING" ]] &&
     [[ "$CURRENT_IMAGE" == *"@$RESTART_DIGEST"* ]]; then
    break
  fi
  sleep 0.5
done

[[ -n "$RESTART_DEPLOYMENT_ID" ]]   || fail "restart scenario did not persist deployment intent"
[[ "$RESTART_OPERATION_STATUS" == "RUNNING" || "$RESTART_OPERATION_STATUS" == "VERIFYING" ]]   || fail "restart scenario operation became terminal before API crash: $RESTART_OPERATION_STATUS"
[[ "$CURRENT_IMAGE" == *"@$RESTART_DIGEST"* ]]   || fail "restart scenario Docker mutation was not accepted before API crash"

cat >"$LOG_DIR/restart-before-crash.txt" <<EOF
deployment_id=$RESTART_DEPLOYMENT_ID
operation_id=$RESTART_OPERATION_ID
operation_status=$RESTART_OPERATION_STATUS
service_image=$CURRENT_IMAGE
EOF

crash_api
wait "$RESTART_REQUEST_PID" 2>/dev/null || true

log "restarting Nest API against persisted MySQL state"
start_api append
wait_http "$API_URL/health" 200 120

RESTART_DEPLOY_JSON="$(wait_deployment_terminal   "$RESTART_DEPLOYMENT_ID"   SUCCESS   "$LOG_DIR/restart-deploy-status.json"   120)"
printf '%s\n' "$RESTART_DEPLOY_JSON" >"$LOG_DIR/restart-deploy.json"

wait_for_body "$HEALTH_URL" "v3"
wait_http "$HEALTH_URL/health" 200 60

RESTART_SERVICE_JSON="$(api_get "/v1/clusters/default/services/$SERVICE_ID")"
printf '%s\n' "$RESTART_SERVICE_JSON" >"$LOG_DIR/service-after-api-restart.json"
jq -e --arg digest "$RESTART_DIGEST"   '.service.image | contains("@" + $digest)'   <<<"$RESTART_SERVICE_JSON" >/dev/null   || fail "API restart reconciliation did not preserve target digest"

assert_image_mutation_count "$RESTART_DIGEST" 1 "API restart deployment"

docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e "SELECT action FROM audit_events WHERE operation_id = '$RESTART_OPERATION_ID' ORDER BY id"   2>/dev/null >"$LOG_DIR/restart-audit-actions.txt"

[[ "$(grep -c '^DEPLOY_STARTED$' "$LOG_DIR/restart-audit-actions.txt" || true)" == "1" ]]   || fail "restart deployment must have exactly one DEPLOY_STARTED audit"
[[ "$(grep -c '^DEPLOY_SUCCEEDED$' "$LOG_DIR/restart-audit-actions.txt" || true)" == "1" ]]   || fail "restart deployment must have exactly one DEPLOY_SUCCEEDED audit"
if grep -Eq 'DEPLOY_FAILED|DEPLOY_NEEDS_ATTENTION' "$LOG_DIR/restart-audit-actions.txt"; then
  fail "restart deployment recorded failure/attention audit"
fi

log "scenario: Agent response loss after accepted image mutation"
LOSS_RELEASE_JSON="$(api_post   "/v1/applications/$APP_ID/releases"   '{
    "version":"v4",
    "imageRepository":"http://127.0.0.1:5000/docklane-poc",
    "imageTag":"v4",
    "gitCommit":"functional-poc-response-loss",
    "buildNumber":"manual-smoke-response-loss"
  }')"
printf '%s\n' "$LOSS_RELEASE_JSON" >"$LOG_DIR/response-loss-release.json"
LOSS_RELEASE_ID="$(jq -er '.id' <<<"$LOSS_RELEASE_JSON")"
LOSS_DIGEST="$(jq -er '.imageDigest' <<<"$LOSS_RELEASE_JSON")"
LOSS_OPERATION_ID="functional-poc-deploy-response-loss"
: >"$LOG_DIR/agent-proxy-drops.log"
touch "$LOG_DIR/drop-agent-image-response"

LOSS_DEPLOY_JSON="$(api_post   "/v1/clusters/default/targets/$TARGET_ID/deploy"   "$(jq -cn     --arg releaseId "$LOSS_RELEASE_ID"     --argjson health "$HEALTH_JSON"     --arg operationId "$LOSS_OPERATION_ID"     '{
      operationId: $operationId,
      releaseId: $releaseId,
      health: $health
    }')")"
printf '%s\n' "$LOSS_DEPLOY_JSON" >"$LOG_DIR/response-loss-deploy-initial.json"
LOSS_DEPLOYMENT_ID="$(jq -er '.id' <<<"$LOSS_DEPLOY_JSON")"

LOSS_DEPLOY_JSON="$(wait_deployment_terminal   "$LOSS_DEPLOYMENT_ID"   SUCCESS   "$LOG_DIR/response-loss-deploy-status.json"   120)"
printf '%s\n' "$LOSS_DEPLOY_JSON" >"$LOG_DIR/response-loss-deploy.json"

[[ ! -f "$LOG_DIR/drop-agent-image-response" ]]   || fail "Agent response-loss marker was not consumed"
[[ "$(wc -l <"$LOG_DIR/agent-proxy-drops.log" | tr -d ' ')" == "1" ]]   || fail "expected exactly one dropped Agent image response"

wait_for_body "$HEALTH_URL" "v4"
wait_http "$HEALTH_URL/health" 200 60

LOSS_SERVICE_JSON="$(api_get "/v1/clusters/default/services/$SERVICE_ID")"
printf '%s\n' "$LOSS_SERVICE_JSON" >"$LOG_DIR/service-after-response-loss.json"
jq -e --arg digest "$LOSS_DIGEST"   '.service.image | contains("@" + $digest)'   <<<"$LOSS_SERVICE_JSON" >/dev/null   || fail "response-loss reconciliation did not preserve target digest"

assert_image_mutation_count "$LOSS_DIGEST" 1 "Agent response-loss deployment"

docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e "SELECT action FROM audit_events WHERE operation_id = '$LOSS_OPERATION_ID' ORDER BY id"   2>/dev/null >"$LOG_DIR/response-loss-audit-actions.txt"

[[ "$(grep -c '^DEPLOY_STARTED$' "$LOG_DIR/response-loss-audit-actions.txt" || true)" == "1" ]]   || fail "response-loss deployment must have exactly one DEPLOY_STARTED audit"
[[ "$(grep -c '^DEPLOY_SUCCEEDED$' "$LOG_DIR/response-loss-audit-actions.txt" || true)" == "1" ]]   || fail "response-loss deployment must have exactly one DEPLOY_SUCCEEDED audit"
if grep -Eq 'DEPLOY_FAILED|DEPLOY_NEEDS_ATTENTION' "$LOG_DIR/response-loss-audit-actions.txt"; then
  fail "response-loss deployment recorded failure/attention audit"
fi

log "scenario: external CLI service spec conflict during deployment verification"
EXTERNAL_RELEASE_JSON="$(api_post   "/v1/applications/$APP_ID/releases"   '{
    "version":"v5",
    "imageRepository":"http://127.0.0.1:5000/docklane-poc",
    "imageTag":"v5",
    "gitCommit":"functional-poc-external-conflict",
    "buildNumber":"manual-smoke-external-conflict"
  }')"
printf '%s\n' "$EXTERNAL_RELEASE_JSON" >"$LOG_DIR/external-conflict-release.json"
EXTERNAL_RELEASE_ID="$(jq -er '.id' <<<"$EXTERNAL_RELEASE_JSON")"
EXTERNAL_DIGEST="$(jq -er '.imageDigest' <<<"$EXTERNAL_RELEASE_JSON")"
EXTERNAL_OPERATION_ID="functional-poc-deploy-external-conflict"

EXTERNAL_HEALTH_JSON='{
  "url":"http://127.0.0.1:18080/health",
  "intervalMs":250,
  "timeoutMs":1000,
  "retries":10,
  "stabilityWindowMs":10000,
  "expectedStatus":200
}'

(
  curl -sS     -X POST     -H "Authorization: Bearer $OPERATOR_TOKEN"     -H 'Content-Type: application/json'     --data "$(jq -cn       --arg releaseId "$EXTERNAL_RELEASE_ID"       --argjson health "$EXTERNAL_HEALTH_JSON"       --arg operationId "$EXTERNAL_OPERATION_ID"       '{
        operationId: $operationId,
        releaseId: $releaseId,
        health: $health
      }')"     "$API_URL/v1/clusters/default/targets/$TARGET_ID/deploy"     >"$LOG_DIR/external-conflict-deploy-post.json"     2>"$LOG_DIR/external-conflict-deploy-post.err" || true
) &
EXTERNAL_REQUEST_PID="$!"

EXTERNAL_DEPLOYMENT_ID=""
EXTERNAL_OPERATION_STATUS=""
CURRENT_IMAGE=""
for _ in {1..120}; do
  EXTERNAL_OPERATION_STATUS="$(docker exec "$MYSQL_CONTAINER"     mysql -uroot -pdocklane docklane     --batch --skip-column-names     -e "SELECT status FROM operations WHERE id = '$EXTERNAL_OPERATION_ID' LIMIT 1"     2>/dev/null || true)"
  EXTERNAL_DEPLOYMENT_ID="$(docker exec "$MYSQL_CONTAINER"     mysql -uroot -pdocklane docklane     --batch --skip-column-names     -e "SELECT id FROM deployments WHERE operation_id = '$EXTERNAL_OPERATION_ID' LIMIT 1"     2>/dev/null || true)"
  CURRENT_IMAGE="$(docker service inspect "$SERVICE_NAME" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"

  if [[ -n "$EXTERNAL_DEPLOYMENT_ID" ]] &&
     [[ "$EXTERNAL_OPERATION_STATUS" == "RUNNING" || "$EXTERNAL_OPERATION_STATUS" == "VERIFYING" ]] &&
     [[ "$CURRENT_IMAGE" == *"@$EXTERNAL_DIGEST"* ]]; then
    break
  fi
  sleep 0.25
done

[[ -n "$EXTERNAL_DEPLOYMENT_ID" ]]   || fail "external conflict scenario did not persist deployment intent"
[[ "$EXTERNAL_OPERATION_STATUS" == "RUNNING" || "$EXTERNAL_OPERATION_STATUS" == "VERIFYING" ]]   || fail "external conflict scenario operation became terminal before CLI mutation: $EXTERNAL_OPERATION_STATUS"
[[ "$CURRENT_IMAGE" == *"@$EXTERNAL_DIGEST"* ]]   || fail "external conflict scenario target image was not observed before CLI mutation"

docker service update   --label-add docklane.poc.external-conflict=1   "$SERVICE_NAME"   >"$LOG_DIR/external-conflict-cli-update.log"

wait "$EXTERNAL_REQUEST_PID" 2>/dev/null || true

EXTERNAL_DEPLOY_JSON="$(wait_deployment_terminal   "$EXTERNAL_DEPLOYMENT_ID"   NEEDS_ATTENTION   "$LOG_DIR/external-conflict-deploy-status.json"   120)"
printf '%s\n' "$EXTERNAL_DEPLOY_JSON" >"$LOG_DIR/external-conflict-deploy.json"

EXTERNAL_STATUS_JSON="$(api_get "/v1/clusters/default/deployments/$EXTERNAL_DEPLOYMENT_ID/status")"
printf '%s\n' "$EXTERNAL_STATUS_JSON" >"$LOG_DIR/external-conflict-status.json"
jq -e   '.deployment.status == "NEEDS_ATTENTION"
    and .operation.status == "NEEDS_ATTENTION"
    and .operation.errorCode == "EXTERNAL_SERVICE_CONFLICT"'   <<<"$EXTERNAL_STATUS_JSON" >/dev/null   || fail "external CLI spec change was not classified as EXTERNAL_SERVICE_CONFLICT"

wait_for_body "$HEALTH_URL" "v5"
wait_http "$HEALTH_URL/health" 200 60
assert_image_mutation_count "$EXTERNAL_DIGEST" 1 "external CLI conflict deployment"

docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e "SELECT action FROM audit_events WHERE operation_id = '$EXTERNAL_OPERATION_ID' ORDER BY id"   2>/dev/null >"$LOG_DIR/external-conflict-audit-actions.txt"

[[ "$(grep -c '^DEPLOY_STARTED
docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e 'SELECT action FROM audit_events ORDER BY id'   2>/dev/null >"$LOG_DIR/audit-actions.txt"

for action in   APPLICATION_CREATED   DEPLOYMENT_TARGET_CREATED   RELEASE_CREATED   DEPLOY_STARTED   DEPLOY_SUCCEEDED   DEPLOY_NO_OP_STARTED   DEPLOY_NO_OP_SUCCEEDED   DEPLOY_FAILED   ROLLBACK_STARTED   ROLLBACK_SUCCEEDED; do
  grep -qx "$action" "$LOG_DIR/audit-actions.txt"     || fail "missing audit action: $action"
done

cat >"$LOG_DIR/summary.txt" <<EOF
normal digest deploy: PASS
same digest/spec no-op redeploy: PASS
broken release manual rollback: PASS
API restart during update: PASS
Agent response loss: PASS
external CLI conflict: PASS
authorization rejection: PASS
audit completeness: PASS
release digest: $RELEASE_DIGEST
service id: $SERVICE_ID
EOF

log "functional PoC smoke passed"
cat "$LOG_DIR/summary.txt"
 "$LOG_DIR/external-conflict-audit-actions.txt" || true)" == "1" ]]   || fail "external conflict deployment must have exactly one DEPLOY_STARTED audit"
[[ "$(grep -c '^DEPLOY_NEEDS_ATTENTION
docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e 'SELECT action FROM audit_events ORDER BY id'   2>/dev/null >"$LOG_DIR/audit-actions.txt"

for action in   APPLICATION_CREATED   DEPLOYMENT_TARGET_CREATED   RELEASE_CREATED   DEPLOY_STARTED   DEPLOY_SUCCEEDED   DEPLOY_NO_OP_STARTED   DEPLOY_NO_OP_SUCCEEDED   DEPLOY_FAILED   ROLLBACK_STARTED   ROLLBACK_SUCCEEDED; do
  grep -qx "$action" "$LOG_DIR/audit-actions.txt"     || fail "missing audit action: $action"
done

cat >"$LOG_DIR/summary.txt" <<EOF
normal digest deploy: PASS
same digest/spec no-op redeploy: PASS
broken release manual rollback: PASS
API restart during update: PASS
Agent response loss: PASS
authorization rejection: PASS
audit completeness: PASS
release digest: $RELEASE_DIGEST
service id: $SERVICE_ID
EOF

log "functional PoC smoke passed"
cat "$LOG_DIR/summary.txt"
 "$LOG_DIR/external-conflict-audit-actions.txt" || true)" == "1" ]]   || fail "external conflict deployment must have exactly one DEPLOY_NEEDS_ATTENTION audit"
if grep -Eq 'DEPLOY_SUCCEEDED|DEPLOY_FAILED' "$LOG_DIR/external-conflict-audit-actions.txt"; then
  fail "external conflict deployment recorded success/failure instead of operator attention"
fi

log "scenario: audit completeness"
docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e 'SELECT action FROM audit_events ORDER BY id'   2>/dev/null >"$LOG_DIR/audit-actions.txt"

for action in   APPLICATION_CREATED   DEPLOYMENT_TARGET_CREATED   RELEASE_CREATED   DEPLOY_STARTED   DEPLOY_SUCCEEDED   DEPLOY_NO_OP_STARTED   DEPLOY_NO_OP_SUCCEEDED   DEPLOY_FAILED   ROLLBACK_STARTED   ROLLBACK_SUCCEEDED; do
  grep -qx "$action" "$LOG_DIR/audit-actions.txt"     || fail "missing audit action: $action"
done

cat >"$LOG_DIR/summary.txt" <<EOF
normal digest deploy: PASS
same digest/spec no-op redeploy: PASS
broken release manual rollback: PASS
API restart during update: PASS
Agent response loss: PASS
authorization rejection: PASS
audit completeness: PASS
release digest: $RELEASE_DIGEST
service id: $SERVICE_ID
EOF

log "functional PoC smoke passed"
cat "$LOG_DIR/summary.txt"
