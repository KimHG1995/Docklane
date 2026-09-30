#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc-3node}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
NETWORK_NAME="docklane-poc-3node-net"
MANAGER_CONTAINER="docklane-poc-manager-01"
WORKER_01_CONTAINER="docklane-poc-worker-01"
WORKER_02_CONTAINER="docklane-poc-worker-02"
DIND_IMAGE="${DOCKLANE_POC_DIND_IMAGE:-docker:28-dind}"
MANAGER_DOCKER_HOST="tcp://127.0.0.1:22375"
MYSQL_CONTAINER="docklane-poc-mysql"
API_URL="http://127.0.0.1:3001"
AGENT_URL="http://127.0.0.1:9443"
OPERATOR_TOKEN="docklane-poc-operator-00000001"
VIEWER_TOKEN="docklane-poc-viewer-0000000001"
DRAIN_SERVICE_NAME="docklane-poc-drain"

cleanup() {
  bash "$ROOT_DIR/tests/functional-poc/cleanup.sh" || true
}

log() {
  printf '[functional-poc-3node] %s\n' "$*"
}

fail() {
  printf '[functional-poc-3node] ERROR: %s\n' "$*" >&2
  exit 1
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

api_get() {
  local path="$1"
  curl -fsS -H "Authorization: Bearer $OPERATOR_TOKEN" "$API_URL$path"
}

api_post() {
  local path="$1"
  local body="$2"
  curl -fsS     -X POST     -H "Authorization: Bearer $OPERATOR_TOKEN"     -H 'Content-Type: application/json'     --data "$body"     "$API_URL$path"
}

wait_node_operation_terminal() {
  local operation_id="$1"
  local expected="$2"
  local output_file="$3"

  for _ in {1..90}; do
    local operation_json status
    operation_json="$(api_get "/v1/clusters/default/node-operations/$operation_id")"
    printf '%s\n' "$operation_json" >"$output_file"
    status="$(jq -er '.status' <<<"$operation_json")"

    case "$status" in
      "$expected")
        printf '%s\n' "$operation_json"
        return 0
        ;;
      FAILED|NEEDS_ATTENTION)
        fail "node operation $operation_id reached terminal status $status; expected $expected"
        ;;
    esac
    sleep 1
  done

  fail "timed out waiting for node operation $operation_id to reach $expected"
}

wait_service_running_task() {
  local service_id="$1"
  local output_file="$2"

  for _ in {1..120}; do
    DOCKER_HOST="$MANAGER_DOCKER_HOST" docker service ps       --filter desired-state=running       --format '{{.ID}}|{{.Node}}|{{.CurrentState}}'       "$service_id" >"$output_file" 2>/dev/null || true

    if grep -q '|Running ' "$output_file"; then
      return 0
    fi
    sleep 1
  done

  fail "service $service_id did not obtain a running task"
}

wait_worker_failure_relocation() {
  local service_id="$1"
  local failed_task_id="$2"
  local failed_node_name="$3"
  local output_file="$4"

  for _ in {1..150}; do
    DOCKER_HOST="$MANAGER_DOCKER_HOST" docker service ps       --filter desired-state=running       --format '{{.ID}}|{{.Node}}|{{.CurrentState}}'       "$service_id" >"$output_file" 2>/dev/null || true

    local line task_id node_name
    line="$(grep '|Running ' "$output_file" | head -n1 || true)"
    if [[ -n "$line" ]]; then
      IFS='|' read -r task_id node_name _ <<<"$line"
      if [[ "$task_id" != "$failed_task_id" && "$node_name" != "$failed_node_name" ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "service $service_id was not relocated away from failed worker $failed_node_name"
}

wait_docklane_service_converged() {
  local service_id="$1"
  local expected_replicas="$2"
  local output_file="$3"

  for _ in {1..150}; do
    local body
    body="$(api_get "/v1/clusters/default/services/$service_id" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      printf '%s\n' "$body" >"$output_file"
      if jq -e --argjson replicas "$expected_replicas" '
        .service.desiredReplicas == $replicas
        and .service.runningReplicas == $replicas
        and ([.tasks[] | select(.desiredState == "running" and .state == "running")] | length) == $replicas
      ' <<<"$body" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "Docklane service read model did not converge to $expected_replicas/$expected_replicas for $service_id"
}

wait_docklane_node_not_ready() {
  local node_id="$1"
  local output_file="$2"

  for _ in {1..150}; do
    local body state
    body="$(api_get "/v1/clusters/default/nodes/$node_id" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      printf '%s\n' "$body" >"$output_file"
      state="$(jq -er '.node.state' <<<"$body" 2>/dev/null || true)"
      if [[ -n "$state" && "$state" != "ready" ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "Docklane did not observe failed node $node_id as non-ready"
}

preflight_absent_container() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    fail "three-node PoC refuses to start because container already exists: $name"
  fi
}

preflight_absent_network() {
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    fail "three-node PoC refuses to start because network already exists: $NETWORK_NAME"
  fi
}

wait_dind() {
  local container="$1"
  for _ in {1..90}; do
    if docker exec "$container" docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Docker daemon did not become ready in $container"
}

wait_three_nodes_ready() {
  for _ in {1..90}; do
    docker exec "$MANAGER_CONTAINER" docker node ls       --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}'       >"$LOG_DIR/three-node-topology.txt" 2>"$LOG_DIR/three-node-topology.err" || true

    local total ready
    total="$(wc -l <"$LOG_DIR/three-node-topology.txt" | tr -d ' ')"
    ready="$(grep -c '|Ready|Active|' "$LOG_DIR/three-node-topology.txt" || true)"
    if [[ "$total" == "3" && "$ready" == "3" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "three-node Swarm did not converge to three Ready/Active nodes"
}

preflight_absent_container "$MANAGER_CONTAINER"
preflight_absent_container "$WORKER_01_CONTAINER"
preflight_absent_container "$WORKER_02_CONTAINER"
preflight_absent_container "$MYSQL_CONTAINER"
preflight_absent_container "docklane-poc-external-lb"
preflight_absent_network

mkdir -p "$LOG_DIR"
rm -rf "$OWNERSHIP_DIR"
mkdir -p "$OWNERSHIP_DIR"
trap cleanup EXIT

log "creating isolated outer Docker network"
NETWORK_ID="$(docker network create "$NETWORK_NAME")"
printf '%s\n' "$NETWORK_ID" >"$OWNERSHIP_DIR/three-node-network.network-id"

log "starting manager-01 Docker-in-Docker daemon"
MANAGER_CONTAINER_ID="$(docker run -d   --privileged   --name "$MANAGER_CONTAINER"   --hostname manager-01   --network "$NETWORK_NAME"   -e DOCKER_TLS_CERTDIR=   -p 127.0.0.1:22375:2375   "$DIND_IMAGE"   --host=unix:///var/run/docker.sock   --host=tcp://0.0.0.0:2375)"
printf '%s\n' "$MANAGER_CONTAINER_ID" >"$OWNERSHIP_DIR/manager-01.container-id"

log "starting worker Docker-in-Docker daemons"
WORKER_01_CONTAINER_ID="$(docker run -d   --privileged   --name "$WORKER_01_CONTAINER"   --hostname worker-01   --network "$NETWORK_NAME"   -e DOCKER_TLS_CERTDIR=   "$DIND_IMAGE")"
printf '%s\n' "$WORKER_01_CONTAINER_ID" >"$OWNERSHIP_DIR/worker-01.container-id"

WORKER_02_CONTAINER_ID="$(docker run -d   --privileged   --name "$WORKER_02_CONTAINER"   --hostname worker-02   --network "$NETWORK_NAME"   -e DOCKER_TLS_CERTDIR=   "$DIND_IMAGE")"
printf '%s\n' "$WORKER_02_CONTAINER_ID" >"$OWNERSHIP_DIR/worker-02.container-id"

wait_dind "$MANAGER_CONTAINER"
wait_dind "$WORKER_01_CONTAINER"
wait_dind "$WORKER_02_CONTAINER"

MANAGER_IP="$(docker inspect   --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}"   "$MANAGER_CONTAINER")"
[[ -n "$MANAGER_IP" ]] || fail "could not resolve manager-01 outer network address"

log "initializing manager-01 Swarm at $MANAGER_IP"
docker exec "$MANAGER_CONTAINER" docker swarm init   --advertise-addr "$MANAGER_IP"   >"$LOG_DIR/three-node-swarm-init.log"

WORKER_TOKEN="$(docker exec "$MANAGER_CONTAINER" docker swarm join-token -q worker)"
[[ -n "$WORKER_TOKEN" ]] || fail "could not read Swarm worker join token"

log "joining worker-01"
docker exec "$WORKER_01_CONTAINER" docker swarm join   --token "$WORKER_TOKEN"   "$MANAGER_IP:2377"   >"$LOG_DIR/worker-01-join.log"

log "joining worker-02"
docker exec "$WORKER_02_CONTAINER" docker swarm join   --token "$WORKER_TOKEN"   "$MANAGER_IP:2377"   >"$LOG_DIR/worker-02-join.log"

wait_three_nodes_ready

grep -q '^manager-01|Ready|Active|Leader$' "$LOG_DIR/three-node-topology.txt"   || fail "manager-01 is not the Ready/Active Swarm leader"
grep -q '^worker-01|Ready|Active|$' "$LOG_DIR/three-node-topology.txt"   || fail "worker-01 is not Ready/Active"
grep -q '^worker-02|Ready|Active|$' "$LOG_DIR/three-node-topology.txt"   || fail "worker-02 is not Ready/Active"

log "verifying manager Docker API through host loopback"
DOCKER_HOST="$MANAGER_DOCKER_HOST" docker info >"$LOG_DIR/manager-docker-info.txt"
DOCKER_HOST="$MANAGER_DOCKER_HOST" docker node ls   --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}'   >"$LOG_DIR/manager-api-node-ls.txt"
sort "$LOG_DIR/three-node-topology.txt" >"$LOG_DIR/three-node-topology.sorted.txt"
sort "$LOG_DIR/manager-api-node-ls.txt" >"$LOG_DIR/manager-api-node-ls.sorted.txt"
cmp "$LOG_DIR/three-node-topology.sorted.txt" "$LOG_DIR/manager-api-node-ls.sorted.txt"   || fail "manager Docker API view differs between in-container and host-loopback access"

log "starting MySQL for Docklane node-drain scenario"
MYSQL_CONTAINER_ID="$(docker run -d   --name "$MYSQL_CONTAINER"   -e MYSQL_ROOT_PASSWORD=docklane   -e MYSQL_DATABASE=docklane   -p 33306:3306   mysql:8.4)"
printf '%s\n' "$MYSQL_CONTAINER_ID" >"$OWNERSHIP_DIR/mysql.container-id"

for _ in {1..90}; do
  if docker exec "$MYSQL_CONTAINER" mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$MYSQL_CONTAINER" mysqladmin ping -uroot -pdocklane --silent >/dev/null 2>&1   || fail "MySQL did not become ready"

log "pre-pulling node-drain fixture image on all nested Docker daemons"
docker exec "$MANAGER_CONTAINER" docker pull alpine:3.21 >"$LOG_DIR/manager-pull-alpine.log"
docker exec "$WORKER_01_CONTAINER" docker pull alpine:3.21 >"$LOG_DIR/worker-01-pull-alpine.log"
docker exec "$WORKER_02_CONTAINER" docker pull alpine:3.21 >"$LOG_DIR/worker-02-pull-alpine.log"

log "creating worker-only fixture service"
DRAIN_SERVICE_ID="$(DOCKER_HOST="$MANAGER_DOCKER_HOST" docker service create   --quiet   --name "$DRAIN_SERVICE_NAME"   --replicas 1   --constraint node.role==worker   alpine:3.21   sleep 3600)"
printf '%s\n' "$DRAIN_SERVICE_ID" >"$LOG_DIR/drain-service.id"

wait_service_running_task "$DRAIN_SERVICE_ID" "$LOG_DIR/drain-service-before.txt"
DRAIN_TASK_BEFORE="$(grep '|Running ' "$LOG_DIR/drain-service-before.txt" | head -n1)"
IFS='|' read -r DRAIN_TASK_BEFORE_ID DRAIN_NODE_NAME _ <<<"$DRAIN_TASK_BEFORE"
[[ "$DRAIN_NODE_NAME" == "worker-01" || "$DRAIN_NODE_NAME" == "worker-02" ]]   || fail "fixture task was not scheduled on a worker: $DRAIN_NODE_NAME"

log "building Docklane API and Agent for node-drain scenario"
(
  cd "$ROOT_DIR/agent"
  go build -o bin/docklane-agent ./cmd/docklane-agent
)
(
  cd "$ROOT_DIR"
  pnpm --filter @docklane/api build
)

log "starting Docklane Agent against manager-01 Docker API"
(
  export DOCKER_HOST="$MANAGER_DOCKER_HOST"
  export DOCKLANE_AGENT_INSECURE_DEV=true
  export DOCKLANE_AGENT_ADDR=127.0.0.1:9443
  exec "$ROOT_DIR/agent/bin/docklane-agent"
) >"$LOG_DIR/agent.log" 2>&1 &
echo "$!" >"$LOG_DIR/agent.pid"
cp "$LOG_DIR/agent.pid" "$OWNERSHIP_DIR/agent.pid"

wait_http "$AGENT_URL/v1/health" 200 60

TOKENS_JSON="$(jq -cn   --arg operator "$OPERATOR_TOKEN"   --arg viewer "$VIEWER_TOKEN"   '[
    {token: $operator, actorId: "functional-poc-operator", role: "OPERATOR", clusters: ["default"]},
    {token: $viewer, actorId: "functional-poc-viewer", role: "VIEWER", clusters: ["default"]}
  ]')"

log "starting Docklane API"
(
  export PORT=3001
  export DOCKLANE_CLUSTER_ID=default
  export DOCKLANE_DATABASE_URL='mysql://root:docklane@127.0.0.1:33306/docklane'
  export DOCKLANE_AGENT_INSECURE_DEV=true
  export DOCKLANE_AGENT_URL="$AGENT_URL"
  export DOCKLANE_API_TOKENS="$TOKENS_JSON"
  export DOCKLANE_REGISTRY_PRIVATE_HOSTS='127.0.0.1:5000'
  export DOCKLANE_REGISTRY_AUTH_JSON='{}'
  exec node "$ROOT_DIR/apps/api/dist/main.js"
) >"$LOG_DIR/api.log" 2>&1 &
echo "$!" >"$LOG_DIR/api.pid"
cp "$LOG_DIR/api.pid" "$OWNERSHIP_DIR/api.pid"

wait_http "$API_URL/health" 200 90

DRAIN_NODE_JSON="$(api_get "/v1/clusters/default/nodes/$DRAIN_NODE_NAME")"
printf '%s\n' "$DRAIN_NODE_JSON" >"$LOG_DIR/drain-node-before.json"
DRAIN_NODE_ID="$(jq -er '.node.id' <<<"$DRAIN_NODE_JSON")"
DRAIN_NODE_VERSION="$(jq -er '.node.version' <<<"$DRAIN_NODE_JSON")"
jq -e --arg serviceId "$DRAIN_SERVICE_ID" '.serviceIds | index($serviceId) != null' <<<"$DRAIN_NODE_JSON" >/dev/null   || fail "Docklane node detail did not observe fixture service before drain"

DRAIN_OPERATION_ID="22222222-2222-4222-8222-222222222222"
log "draining $DRAIN_NODE_NAME through Docklane API"
DRAIN_OPERATION_JSON="$(api_post   "/v1/clusters/default/nodes/$DRAIN_NODE_ID/drain"   "$(jq -cn     --arg operationId "$DRAIN_OPERATION_ID"     --argjson expectedVersion "$DRAIN_NODE_VERSION"     '{operationId: $operationId, expectedVersion: $expectedVersion}')")"
printf '%s\n' "$DRAIN_OPERATION_JSON" >"$LOG_DIR/drain-operation-initial.json"

if [[ "$(jq -er '.status' <<<"$DRAIN_OPERATION_JSON")" != "SUCCESS" ]]; then
  DRAIN_OPERATION_JSON="$(wait_node_operation_terminal     "$DRAIN_OPERATION_ID"     SUCCESS     "$LOG_DIR/drain-operation-status.json")"
fi
printf '%s\n' "$DRAIN_OPERATION_JSON" >"$LOG_DIR/drain-operation.json"

jq -e '.type == "DRAIN" and .status == "SUCCESS" and .targetAvailability == "drain"'   <<<"$DRAIN_OPERATION_JSON" >/dev/null   || fail "Docklane drain operation did not finish SUCCESS"

DRAIN_NODE_AFTER_JSON="$(api_get "/v1/clusters/default/nodes/$DRAIN_NODE_ID")"
printf '%s\n' "$DRAIN_NODE_AFTER_JSON" >"$LOG_DIR/drain-node-after.json"
jq -e '.node.availability == "drain"
    and ([.tasks[] | select(.serviceId != "")] | length) == 0'   <<<"$DRAIN_NODE_AFTER_JSON" >/dev/null   || fail "drained node still has service tasks"

wait_service_running_task "$DRAIN_SERVICE_ID" "$LOG_DIR/drain-service-after.txt"
DRAIN_TASK_AFTER="$(grep '|Running ' "$LOG_DIR/drain-service-after.txt" | head -n1)"
IFS='|' read -r DRAIN_TASK_AFTER_ID DRAIN_NODE_AFTER_NAME _ <<<"$DRAIN_TASK_AFTER"
[[ "$DRAIN_TASK_AFTER_ID" != "$DRAIN_TASK_BEFORE_ID" ]]   || fail "drain did not replace the original service task"
[[ "$DRAIN_NODE_AFTER_NAME" != "$DRAIN_NODE_NAME" ]]   || fail "replacement task remained on drained node $DRAIN_NODE_NAME"
[[ "$DRAIN_NODE_AFTER_NAME" == "worker-01" || "$DRAIN_NODE_AFTER_NAME" == "worker-02" ]]   || fail "replacement task did not move to the other worker: $DRAIN_NODE_AFTER_NAME"

ACTIVATE_NODE_VERSION="$(jq -er '.node.version' <<<"$DRAIN_NODE_AFTER_JSON")"
ACTIVATE_OPERATION_ID="33333333-3333-4333-8333-333333333333"
log "reactivating $DRAIN_NODE_NAME through Docklane API"
ACTIVATE_OPERATION_JSON="$(api_post   "/v1/clusters/default/nodes/$DRAIN_NODE_ID/activate"   "$(jq -cn     --arg operationId "$ACTIVATE_OPERATION_ID"     --argjson expectedVersion "$ACTIVATE_NODE_VERSION"     '{operationId: $operationId, expectedVersion: $expectedVersion}')")"
printf '%s\n' "$ACTIVATE_OPERATION_JSON" >"$LOG_DIR/activate-operation-initial.json"

if [[ "$(jq -er '.status' <<<"$ACTIVATE_OPERATION_JSON")" != "SUCCESS" ]]; then
  ACTIVATE_OPERATION_JSON="$(wait_node_operation_terminal     "$ACTIVATE_OPERATION_ID"     SUCCESS     "$LOG_DIR/activate-operation-status.json")"
fi
printf '%s\n' "$ACTIVATE_OPERATION_JSON" >"$LOG_DIR/activate-operation.json"

ACTIVATE_NODE_JSON="$(api_get "/v1/clusters/default/nodes/$DRAIN_NODE_ID")"
printf '%s\n' "$ACTIVATE_NODE_JSON" >"$LOG_DIR/activate-node-after.json"
jq -e '.node.availability == "active"' <<<"$ACTIVATE_NODE_JSON" >/dev/null   || fail "drained node did not return to active"

docker exec "$MYSQL_CONTAINER"   mysql -uroot -pdocklane docklane   --batch --skip-column-names   -e "SELECT action FROM audit_events WHERE operation_id IN ('$DRAIN_OPERATION_ID', '$ACTIVATE_OPERATION_ID') ORDER BY id"   >"$LOG_DIR/node-drain-audit-actions.txt" 2>/dev/null

for action in NODE_DRAIN_STARTED NODE_DRAIN_SUCCEEDED NODE_ACTIVATE_STARTED NODE_ACTIVATE_SUCCEEDED; do
  [[ "$(grep -c "^$action$" "$LOG_DIR/node-drain-audit-actions.txt" || true)" == "1" ]]     || fail "node drain scenario expected exactly one $action audit"
done

log "scenario: external HAProxy traffic during Docklane restart rollout"
bash "$ROOT_DIR/tests/functional-poc/three-node-external-lb.sh"

log "scenario: Swarm internal port exposure"
bash "$ROOT_DIR/tests/functional-poc/three-node-network-exposure.sh"

log "scenario: worker failure reschedules service task"
wait_service_running_task "$DRAIN_SERVICE_ID" "$LOG_DIR/worker-failure-service-before.txt"
FAILURE_TASK_BEFORE="$(grep '|Running ' "$LOG_DIR/worker-failure-service-before.txt" | head -n1)"
IFS='|' read -r FAILURE_TASK_BEFORE_ID FAILURE_NODE_NAME _ <<<"$FAILURE_TASK_BEFORE"

case "$FAILURE_NODE_NAME" in
  worker-01)
    FAILURE_CONTAINER="$WORKER_01_CONTAINER"
    ;;
  worker-02)
    FAILURE_CONTAINER="$WORKER_02_CONTAINER"
    ;;
  *)
    fail "worker failure scenario task is not running on a worker: $FAILURE_NODE_NAME"
    ;;
esac

FAILURE_NODE_JSON="$(api_get "/v1/clusters/default/nodes/$FAILURE_NODE_NAME")"
printf '%s\n' "$FAILURE_NODE_JSON" >"$LOG_DIR/worker-failure-node-before.json"
FAILURE_NODE_ID="$(jq -er '.node.id' <<<"$FAILURE_NODE_JSON")"

log "stopping outer DinD container for $FAILURE_NODE_NAME"
docker rm -f "$FAILURE_CONTAINER" >"$LOG_DIR/worker-failure-container-rm.log"

wait_docklane_node_not_ready "$FAILURE_NODE_ID" "$LOG_DIR/worker-failure-node-after.json"
wait_worker_failure_relocation   "$DRAIN_SERVICE_ID"   "$FAILURE_TASK_BEFORE_ID"   "$FAILURE_NODE_NAME"   "$LOG_DIR/worker-failure-service-after.txt"

FAILURE_TASK_AFTER="$(grep '|Running ' "$LOG_DIR/worker-failure-service-after.txt" | head -n1)"
IFS='|' read -r FAILURE_TASK_AFTER_ID FAILURE_NODE_AFTER_NAME _ <<<"$FAILURE_TASK_AFTER"
[[ "$FAILURE_TASK_AFTER_ID" != "$FAILURE_TASK_BEFORE_ID" ]]   || fail "worker failure did not create a replacement task"
[[ "$FAILURE_NODE_AFTER_NAME" != "$FAILURE_NODE_NAME" ]]   || fail "replacement task remained on failed worker $FAILURE_NODE_NAME"

wait_docklane_service_converged   "$DRAIN_SERVICE_ID"   1   "$LOG_DIR/worker-failure-service.json"

FAILURE_SERVICE_JSON="$(cat "$LOG_DIR/worker-failure-service.json")"

FAILURE_NODE_AFTER_JSON="$(cat "$LOG_DIR/worker-failure-node-after.json")"
jq -e '.node.state != "ready"' <<<"$FAILURE_NODE_AFTER_JSON" >/dev/null   || fail "Docklane still reports failed worker as ready"

cat >"$LOG_DIR/three-node-summary.txt" <<EOF
manager-01 Ready/Active/Leader: PASS
worker-01 Ready/Active: PASS
worker-02 Ready/Active: PASS
manager Docker API loopback access: PASS
Docklane node drain task relocation: PASS
Docklane node activate recovery: PASS
external HAProxy traffic during Docklane rollout: PASS
Swarm internal ports outer-host blocked: PASS
worker failure task reschedule: PASS
Docklane failed-worker read model: PASS
topology node count: 3
EOF

log "three-node topology PoC passed"
cat "$LOG_DIR/three-node-summary.txt"
