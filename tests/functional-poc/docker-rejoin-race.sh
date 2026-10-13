#!/usr/bin/env bash
# Run only AFTER existing disposable single-node Functional PoC scenarios.
set -Eeuo pipefail

: "${DOCKLANE_REJOIN_LOG_DIR:?required}"
: "${DOCKLANE_REJOIN_SERVICE_ID:?required}"
: "${DOCKLANE_REJOIN_EXPECTED_CLUSTER_ID:?required}"
: "${DOCKLANE_REJOIN_ADVERTISE_ADDR:?required}"
: "${DOCKLANE_REJOIN_AGENT_BINARY:?required}"
: "${DOCKLANE_REJOIN_OWNERSHIP_DIR:?required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$DOCKLANE_REJOIN_LOG_DIR"
OWNERSHIP_DIR="$DOCKLANE_REJOIN_OWNERSHIP_DIR"
AGENT_PORT=19446
PROXY_PORT=12376
EXPECTED="$DOCKLANE_REJOIN_EXPECTED_CLUSTER_ID"
SERVICE_ID="$DOCKLANE_REJOIN_SERVICE_ID"
RACE_MODE="${DOCKLANE_REJOIN_RACE_MODE:-preguard}"
BASE_URL="http://127.0.0.1:$AGENT_PORT"
mkdir -p "$LOG_DIR" "$OWNERSHIP_DIR"

die() {
  printf '[swarm-rejoin] ERROR: %s\n' "$*" >&2
  exit 1
}
[[ "$RACE_MODE" == "preguard" || "$RACE_MODE" == "postguard" ]] || die "invalid race mode"
wait_http() {
  local url="$1"
  for _ in {1..80}; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return; fi
    sleep 0.25
  done
  die "endpoint did not become ready: $url"
}
[[ "$(docker info --format '{{.Swarm.Cluster.ID}}')" == "$EXPECTED" ]] ||
  die "refusing rejoin experiment on an unverified cluster"
[[ "$(docker service inspect "$SERVICE_ID" --format '{{.ID}}')" == "$SERVICE_ID" ]] ||
  die "owned fixture service was not found"

# Both subprocesses are tracked by the existing cleanup harness.
DOCKLANE_REJOIN_LOG_DIR="$LOG_DIR" \
DOCKLANE_REJOIN_SERVICE_ID="$SERVICE_ID" \
DOCKLANE_REJOIN_PROXY_PORT="$PROXY_PORT" \
DOCKLANE_REJOIN_RACE_MODE="$RACE_MODE" \
python3 "$ROOT_DIR/tests/functional-poc/docker-rejoin-proxy.py" >"$LOG_DIR/docker-rejoin-proxy.log" 2>&1 &
echo "$!" >"$OWNERSHIP_DIR/rejoin-docker-proxy.pid"
wait_http "http://127.0.0.1:$PROXY_PORT/__docklane_rejoin_probe"

(
  export DOCKER_HOST="tcp://127.0.0.1:$PROXY_PORT"
  export DOCKLANE_AGENT_INSECURE_DEV=true
  export DOCKLANE_AGENT_ADDR="127.0.0.1:$AGENT_PORT"
  exec "$DOCKLANE_REJOIN_AGENT_BINARY"
) >"$LOG_DIR/docker-rejoin-agent.log" 2>&1 &
echo "$!" >"$OWNERSHIP_DIR/rejoin-agent.pid"
wait_http "$BASE_URL/v1/health"

version="$(docker service inspect "$SERVICE_ID" --format '{{.Version.Index}}')"
plan="$(curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \
  --data "{\"expectedVersion\":$version}" \
  "$BASE_URL/v1/services/$SERVICE_ID/plan-restart")"
printf '%s\n' "$plan" >"$LOG_DIR/docker-rejoin-plan.json"
request="$(jq -cn --argjson plan "$plan" '{
  expectedVersion: $plan.version,
  expectedSpecHash: $plan.beforeSpecHash,
  targetSpecHash: $plan.targetSpecHash
}')"

# The opt-in barrier holds the old service inspect response (preguard) or
# the Docker update request after final SwarmInspect (postguard).
touch "$LOG_DIR/docker-rejoin.arm"
(
  curl -sS --max-time 60 -o "$LOG_DIR/docker-rejoin-response.json" -w '%{http_code}' \
    -X POST -H "X-Docklane-Expected-Cluster-ID: $EXPECTED" \
    -H 'Content-Type: application/json' --data "$request" \
    "$BASE_URL/v2/services/$SERVICE_ID/restart" >"$LOG_DIR/docker-rejoin-status.txt"
) &
request_pid="$!"

held=false
for _ in {1..120}; do
  if [[ -f "$LOG_DIR/docker-rejoin.held" ]]; then held=true; break; fi
  if ! kill -0 "$request_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
[[ "$held" == "true" ]] || die "Agent never reached selected Docker barrier"

if [[ "$RACE_MODE" == "preguard" && -f "$LOG_DIR/docker-rejoin-proxy.jsonl" ]]; then
  jq -se 'all(.[]; .event != "docker_service_update_attempt")' \
    "$LOG_DIR/docker-rejoin-proxy.jsonl" >/dev/null ||
    die "unexpected Docker update before controlled rejoin"
fi

docker swarm leave --force >"$LOG_DIR/docker-rejoin-leave.log"
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == "inactive" ]] ||
  die "owned Swarm A did not leave"
# Leaving the owned Swarm destroys its service; the old service ID can no
# longer be inspected from the new or inactive Swarm. Retire its ownership
# marker only after Docker confirms the original Swarm was actually left.
[[ "$(cat "$OWNERSHIP_DIR/service.id")" == "$SERVICE_ID" ]] ||
  die "service ownership marker changed during rejoin"
rm -f "$OWNERSHIP_DIR/service.id"
docker swarm init --advertise-addr "$DOCKLANE_REJOIN_ADVERTISE_ADDR" >"$LOG_DIR/docker-rejoin-init.log"
NEW_NODE_ID="$(docker info --format '{{.Swarm.NodeID}}')"
NEW_CLUSTER_ID="$(docker info --format '{{.Swarm.Cluster.ID}}')"
[[ -n "$NEW_NODE_ID" && -n "$NEW_CLUSTER_ID" && "$NEW_CLUSTER_ID" != "$EXPECTED" ]] ||
  die "Swarm B must have a new cluster and node ID"
printf '%s\n' "$NEW_NODE_ID" >"$OWNERSHIP_DIR/rejoin-swarm.node-id"

touch "$LOG_DIR/docker-rejoin.release"
wait "$request_pid" || die "Agent restart transport failed"
if [[ "$RACE_MODE" == "preguard" ]]; then
  [[ "$(cat "$LOG_DIR/docker-rejoin-status.txt")" == "412" ]] ||
  die "expected post-rejoin 412, got $(cat "$LOG_DIR/docker-rejoin-status.txt")"
jq -e '.code == "CLUSTER_PRECONDITION_FAILED"' "$LOG_DIR/docker-rejoin-response.json" >/dev/null ||
  die "post-rejoin guard response code mismatch"
jq -se '([.[] | select(.event == "old_service_inspect_held")] | length) == 1 and
         ([.[] | select(.event == "old_service_inspect_released")] | length) == 1 and
         ([.[] | select(.event == "docker_service_update_attempt")] | length) == 0' \
  "$LOG_DIR/docker-rejoin-proxy.jsonl" >/dev/null ||
  die "evidence does not show final guard before Docker update"
else
  jq -se '([.[] | select(.event == "postguard_update_held")] | length) == 1 and
          ([.[] | select(.event == "postguard_update_released")] | length) == 1 and
          ([.[] | select(.event == "docker_service_update_attempt")] | length) == 1' \
    "$LOG_DIR/docker-rejoin-proxy.jsonl" >/dev/null || die "postguard evidence mismatch"
  [[ "$(cat "$LOG_DIR/docker-rejoin-status.txt")" != "200" ]] ||
    die "unexpected successful mutation after Swarm replacement"
fi
[[ -z "$(docker service ls -q)" ]] ||
  die "new Swarm B unexpectedly received a service"

jq -cn --arg before "$EXPECTED" --arg after "$NEW_CLUSTER_ID" --arg mode "$RACE_MODE" \
  --arg status "$(cat "$LOG_DIR/docker-rejoin-status.txt")" \
  --argjson attempts "$([[ "$RACE_MODE" == "preguard" ]] && echo 0 || echo 1)" \
  '{beforeClusterId:$before,afterClusterId:$after,mode:$mode,httpStatus:$status,dockerUpdateAttempts:$attempts}' \
  >"$LOG_DIR/docker-rejoin-evidence.json"

# Leave only the new Swarm node owned by this acceptance run.
[[ "$(docker info --format '{{.Swarm.NodeID}}')" == "$NEW_NODE_ID" ]] ||
  die "rejoin cleanup refuses to leave a different Swarm node"
docker swarm leave --force >"$LOG_DIR/docker-rejoin-final-leave.log"
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == "inactive" ]] ||
  die "rejoined Swarm did not leave cleanly"
rm -f "$OWNERSHIP_DIR/rejoin-swarm.node-id"
printf '[swarm-rejoin] real Docker leave/init at %s barrier: PASS\n' "$RACE_MODE"
