#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${DOCKLANE_POC_LOG_DIR:?DOCKLANE_POC_LOG_DIR is required}"
NETWORK_NAME="docklane-poc-3node-net"
MANAGER_CONTAINER="docklane-poc-manager-01"
WORKER_01_CONTAINER="docklane-poc-worker-01"
WORKER_02_CONTAINER="docklane-poc-worker-02"
LB_CONTAINER="docklane-poc-external-lb"
MANAGER_DOCKER_HOST="tcp://127.0.0.1:22375"
API_URL="http://127.0.0.1:3001"
OPERATOR_TOKEN="docklane-poc-operator-00000001"
LB_SERVICE_NAME="docklane-poc-lb"
LB_URL="http://127.0.0.1:18082"

fail() {
  printf '[functional-poc-3node-lb] ERROR: %s\n' "$*" >&2
  exit 1
}

api_get() {
  curl -fsS -H "Authorization: Bearer $OPERATOR_TOKEN" "$API_URL$1"
}

api_post() {
  curl -fsS -X POST     -H "Authorization: Bearer $OPERATOR_TOKEN"     -H 'Content-Type: application/json'     --data "$2"     "$API_URL$1"
}

wait_http() {
  local url="$1"
  for _ in {1..90}; do
    if [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for HTTP 200 from $url"
}

wait_operation() {
  local id="$1"
  local output="$2"
  for _ in {1..120}; do
    local body status
    body="$(api_get "/v1/clusters/default/operations/$id")"
    printf '%s\n' "$body" >"$output"
    status="$(jq -er '.status' <<<"$body")"
    [[ "$status" == "SUCCESS" ]] && { printf '%s\n' "$body"; return 0; }
    [[ "$status" == "FAILED" || "$status" == "NEEDS_ATTENTION" ]] && fail "restart operation ended $status"
    sleep 1
  done
  fail "restart operation did not complete"
}

for node in "$MANAGER_CONTAINER" "$WORKER_01_CONTAINER" "$WORKER_02_CONTAINER"; do
  docker exec "$node" docker pull nginx:alpine >/dev/null
done

LB_SERVICE_ID="$(DOCKER_HOST="$MANAGER_DOCKER_HOST" docker service create   --quiet   --name "$LB_SERVICE_NAME"   --replicas 2   --constraint node.role==worker   --publish published=18081,target=80,mode=ingress   --update-order start-first   --update-parallelism 1   nginx:alpine)"
printf '%s\n' "$LB_SERVICE_ID" >"$LOG_DIR/lb-service.id"

for _ in {1..120}; do
  running="$(DOCKER_HOST="$MANAGER_DOCKER_HOST" docker service ps     --filter desired-state=running --format '{{.CurrentState}}' "$LB_SERVICE_ID" |
    grep -c '^Running ' || true)"
  [[ "$running" == "2" ]] && break
  sleep 1
done
[[ "${running:-0}" == "2" ]] || fail "LB fixture did not reach two replicas"

cat >"$LOG_DIR/haproxy.cfg" <<EOF
global
  log stdout format raw local0
defaults
  mode http
  timeout connect 2s
  timeout client 5s
  timeout server 5s
frontend docklane_lb
  bind *:8080
  default_backend swarm_ingress
backend swarm_ingress
  option httpchk GET /
  server manager-01 $MANAGER_CONTAINER:18081 check
  server worker-01 $WORKER_01_CONTAINER:18081 check
  server worker-02 $WORKER_02_CONTAINER:18081 check
EOF

LB_CONTAINER_ID="$(docker run -d   --name "$LB_CONTAINER"   --network "$NETWORK_NAME"   -p 127.0.0.1:18082:8080   -v "$LOG_DIR/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro"   haproxy:3.1-alpine)"
printf '%s\n' "$LB_CONTAINER_ID" >"$LOG_DIR/ownership/external-lb.container-id"
wait_http "$LB_URL/"

before="$(api_get "/v1/clusters/default/services/$LB_SERVICE_ID")"
printf '%s\n' "$before" >"$LOG_DIR/lb-service-before.json"
version="$(jq -er '.service.version' <<<"$before")"
operation_id="44444444-4444-4444-8444-444444444444"

stop_file="$LOG_DIR/lb-traffic-stop"
traffic_log="$LOG_DIR/lb-traffic.log"
rm -f "$stop_file"
: >"$traffic_log"
(
  while [[ ! -f "$stop_file" ]]; do
    code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "$LB_URL/" 2>/dev/null || true)"
    [[ -n "$code" ]] || code="000"
    printf '%s|%s\n' "$(date +%s%3N)" "$code" >>"$traffic_log"
    sleep 0.05
  done
) &
traffic_pid="$!"

sleep 1
result="$(api_post "/v1/clusters/default/services/$LB_SERVICE_ID/restart"   "$(jq -cn --arg operationId "$operation_id" --argjson expectedVersion "$version"     '{operationId:$operationId,expectedVersion:$expectedVersion}')")"
printf '%s\n' "$result" >"$LOG_DIR/lb-restart-initial.json"
if [[ "$(jq -er '.status' <<<"$result")" != "SUCCESS" ]]; then
  result="$(wait_operation "$operation_id" "$LOG_DIR/lb-restart-status.json")"
fi
printf '%s\n' "$result" >"$LOG_DIR/lb-restart.json"

sleep 1
touch "$stop_file"
wait "$traffic_pid" || true

requests="$(wc -l <"$traffic_log" | tr -d ' ')"
bad="$(awk -F'|' '$2 != "200" {n++} END {print n+0}' "$traffic_log")"
[[ "$requests" -ge 20 ]] || fail "traffic sample too small: $requests"
[[ "$bad" == "0" ]] || fail "observed $bad non-200 responses during rollout"

after="$(api_get "/v1/clusters/default/services/$LB_SERVICE_ID")"
printf '%s\n' "$after" >"$LOG_DIR/lb-service-after.json"
jq -e '.service.desiredReplicas == 2 and .service.runningReplicas == 2' <<<"$after" >/dev/null   || fail "LB fixture did not converge after Docklane restart"

printf 'external HAProxy traffic during Docklane rollout: PASS (%s requests)\n' "$requests"   >"$LOG_DIR/lb-summary.txt"
cat "$LOG_DIR/lb-summary.txt"
