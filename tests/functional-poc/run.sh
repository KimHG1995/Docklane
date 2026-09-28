#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc}"
MYSQL_CONTAINER="docklane-poc-mysql"
REGISTRY_CONTAINER="docklane-poc-registry"
SERVICE_NAME="docklane-poc"
REGISTRY="127.0.0.1:5000"
IMAGE_REPO="$REGISTRY/docklane-poc"
API_URL="http://127.0.0.1:3001"
AGENT_URL="http://127.0.0.1:9443"
HEALTH_URL="http://127.0.0.1:18080"
OPERATOR_TOKEN="docklane-poc-operator-00000001"
VIEWER_TOKEN="docklane-poc-viewer-0000000001"

mkdir -p "$LOG_DIR"
export DOCKLANE_POC_LOG_DIR="$LOG_DIR"

cleanup() {
  "$ROOT_DIR/tests/functional-poc/cleanup.sh" || true
}
trap cleanup EXIT

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

require_command docker
require_command curl
require_command jq
require_command pnpm
require_command go

if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "inactive" ]]; then
  fail "functional PoC requires a disposable Docker host with Swarm inactive"
fi

cleanup
mkdir -p "$LOG_DIR"

log "starting local OCI registry"
docker run -d   --name "$REGISTRY_CONTAINER"   -p 5000:5000   registry:2 >"$LOG_DIR/registry.container"

wait_http "http://127.0.0.1:5000/v2/" 200 60

log "starting MySQL"
docker run -d   --name "$MYSQL_CONTAINER"   -e MYSQL_ROOT_PASSWORD=docklane   -e MYSQL_DATABASE=docklane   -p 33306:3306   mysql:8.4 >"$LOG_DIR/mysql.container"

for _ in {1..90}; do
  if docker exec "$MYSQL_CONTAINER"     mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$MYSQL_CONTAINER"   mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1   || fail "MySQL did not become ready"

log "building and pushing v1/v2 fixture images"
docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v1   -t "$IMAGE_REPO:v1"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v1.log"

docker build   -f "$ROOT_DIR/tests/functional-poc/app/Dockerfile"   --build-arg VERSION=v2   -t "$IMAGE_REPO:v2"   "$ROOT_DIR/tests/functional-poc/app"   >"$LOG_DIR/docker-build-v2.log"

docker push "$IMAGE_REPO:v1" >"$LOG_DIR/docker-push-v1.log"
docker push "$IMAGE_REPO:v2" >"$LOG_DIR/docker-push-v2.log"

SWARM_ADDR="$(hostname -I | awk '{print $1}')"
[[ -n "$SWARM_ADDR" ]] || fail "could not determine Swarm advertise address"

log "initializing single-node Swarm at $SWARM_ADDR"
docker swarm init --advertise-addr "$SWARM_ADDR" >"$LOG_DIR/swarm-init.log"
touch "$LOG_DIR/swarm-created"

log "creating initial replicated service"
docker service create   --name "$SERVICE_NAME"   --replicas 1   --publish published=18080,target=8080   --update-order start-first   --update-parallelism 1   --reserve-cpu 0.05   --reserve-memory 16M   "$IMAGE_REPO:v1" >"$LOG_DIR/service-create.log"

wait_for_body "$HEALTH_URL" "v1"

SERVICE_ID="$(docker service inspect "$SERVICE_NAME" --format '{{.ID}}')"
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

wait_http "$AGENT_URL/v1/health" 200 60

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

log "starting Nest API"
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
echo "$!" >"$LOG_DIR/api.pid"

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
  "url":"http://127.0.0.1:18080/",
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
printf '%s\n' "$NOOP_JSON" >"$LOG_DIR/noop-deploy.json"
jq -e '.status == "SUCCESS" and .noOp == true' <<<"$NOOP_JSON" >/dev/null   || fail "same digest/spec redeploy was not verified as no-op SUCCESS"

log "scenario: audit completeness"
docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e 'SELECT action FROM audit_events ORDER BY id'   2>/dev/null >"$LOG_DIR/audit-actions.txt"

for action in   APPLICATION_CREATED   DEPLOYMENT_TARGET_CREATED   RELEASE_CREATED   DEPLOY_STARTED   DEPLOY_SUCCEEDED   DEPLOY_NO_OP_STARTED   DEPLOY_NO_OP_SUCCEEDED; do
  grep -qx "$action" "$LOG_DIR/audit-actions.txt"     || fail "missing audit action: $action"
done

cat >"$LOG_DIR/summary.txt" <<EOF
normal digest deploy: PASS
same digest/spec no-op redeploy: PASS
authorization rejection: PASS
audit completeness: PASS
release digest: $RELEASE_DIGEST
service id: $SERVICE_ID
EOF

log "functional PoC smoke passed"
cat "$LOG_DIR/summary.txt"
