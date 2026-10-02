#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
NETWORK_NAME="docklane-or-manager-net"
MANAGER_01_CONTAINER="docklane-or-manager-01"
MANAGER_02_CONTAINER="docklane-or-manager-02"
MANAGER_03_CONTAINER="docklane-or-manager-03"
DIND_IMAGE="${DOCKLANE_OR_DIND_IMAGE:-docker:28-dind}"
AGENT_BINARY="${DOCKLANE_MANAGER_AGENT_BINARY:-}"
PRESSURE_BINARY="${DOCKLANE_RESOURCE_PRESSURE_BINARY:-}"
PRESSURE_CPUS="${DOCKLANE_RESOURCE_PRESSURE_CPUS:-0.75}"
PRESSURE_MEMORY_LIMIT="${DOCKLANE_RESOURCE_PRESSURE_MEMORY_LIMIT:-768m}"
PRESSURE_MEMORY_MIB="${DOCKLANE_RESOURCE_PRESSURE_MEMORY_MIB:-256}"
PRESSURE_WORKERS="${DOCKLANE_RESOURCE_PRESSURE_WORKERS:-4}"
PRESSURE_DURATION="${DOCKLANE_RESOURCE_PRESSURE_DURATION:-30s}"

export DOCKLANE_OR_LOG_DIR="$LOG_DIR"

log() {
  printf '[operational-readiness] %s\n' "$*"
}

fail() {
  printf '[operational-readiness] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  bash "$ROOT_DIR/tests/operational-readiness/cleanup.sh" || true
}

preflight_absent_container() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    fail "refusing to start because container already exists: $name"
  fi
}

preflight_absent_network() {
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    fail "refusing to start because network already exists: $NETWORK_NAME"
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

capture_topology() {
  local observer="$1"
  local output="$2"
  docker exec "$observer" docker node ls \
    --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' \
    >"$output"
}

assert_three_managers_ready() {
  local observer="$1"
  local output="$2"

  capture_topology "$observer" "$output"

  local total ready_active leaders reachable
  total="$(wc -l <"$output" | tr -d ' ')"
  ready_active="$(grep -c '|Ready|Active|' "$output" || true)"
  leaders="$(grep -c '|Leader$' "$output" || true)"
  reachable="$(grep -c '|Reachable$' "$output" || true)"

  [[ "$total" == "3" ]] || fail "expected three managers, got $total"
  [[ "$ready_active" == "3" ]] || fail "expected three Ready/Active managers, got $ready_active"
  [[ "$leaders" == "1" ]] || fail "expected one leader, got $leaders"
  [[ "$reachable" == "2" ]] || fail "expected two reachable followers, got $reachable"
}

wait_three_managers_ready() {
  local observer="$1"
  local output="$2"

  for _ in {1..120}; do
    if assert_three_managers_ready "$observer" "$output" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  fail "three-manager Swarm did not converge"
}

container_for_hostname() {
  case "$1" in
    manager-01) printf '%s\n' "$MANAGER_01_CONTAINER" ;;
    manager-02) printf '%s\n' "$MANAGER_02_CONTAINER" ;;
    manager-03) printf '%s\n' "$MANAGER_03_CONTAINER" ;;
    *) return 1 ;;
  esac
}

wait_agent_identity() {
  local container="$1"
  local output="$2"

  for _ in {1..60}; do
    if timeout 5 docker exec "$container" \
      wget -qO- http://127.0.0.1:9443/v1/identity \
      >"$output" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  docker exec "$container" sh -c 'cat /var/log/docklane-agent.log 2>/dev/null || true' >&2 || true
  fail "Agent identity did not become ready in $container"
}

assert_agent_health() {
  local container="$1"
  local output="$2"

  timeout 5 docker exec "$container" \
    wget -qO- http://127.0.0.1:9443/v1/health \
    >"$output"

  python3 - "$output" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

if payload != {"status": "ok", "component": "docklane-agent"}:
    raise SystemExit(f"unexpected health payload: {payload}")
PY
}

assert_agent_identity() {
  local container="$1"
  local expected_cluster_id="$2"
  local expected_node_id="$3"
  local output="$4"

  timeout 5 docker exec "$container" \
    wget -qO- http://127.0.0.1:9443/v1/identity \
    >"$output"

  python3 - "$output" "$expected_cluster_id" "$expected_node_id" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("clusterId") != sys.argv[2]:
    raise SystemExit(f"cluster mismatch: {payload}")
if payload.get("nodeId") != sys.argv[3]:
    raise SystemExit(f"node mismatch: {payload}")
if payload.get("manager") is not True:
    raise SystemExit(f"manager identity lost: {payload}")
PY
}

[[ -n "$AGENT_BINARY" && -x "$AGENT_BINARY" ]] \
  || fail "DOCKLANE_MANAGER_AGENT_BINARY must point to the built Go Agent"
[[ -n "$PRESSURE_BINARY" && -x "$PRESSURE_BINARY" ]] \
  || fail "DOCKLANE_RESOURCE_PRESSURE_BINARY must point to the built pressure helper"

preflight_absent_container "$MANAGER_01_CONTAINER"
preflight_absent_container "$MANAGER_02_CONTAINER"
preflight_absent_container "$MANAGER_03_CONTAINER"
preflight_absent_network

mkdir -p "$LOG_DIR"
rm -rf "$OWNERSHIP_DIR"
mkdir -p "$OWNERSHIP_DIR"
trap cleanup EXIT

log "creating isolated manager network"
NETWORK_ID="$(docker network create "$NETWORK_NAME")"
printf '%s\n' "$NETWORK_ID" >"$OWNERSHIP_DIR/manager-network.network-id"

log "starting three Docker-in-Docker managers"
MANAGER_01_ID="$(docker run -d --privileged --name "$MANAGER_01_CONTAINER" --hostname manager-01 --network "$NETWORK_NAME" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_01_ID" >"$OWNERSHIP_DIR/manager-01.container-id"
MANAGER_02_ID="$(docker run -d --privileged --name "$MANAGER_02_CONTAINER" --hostname manager-02 --network "$NETWORK_NAME" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_02_ID" >"$OWNERSHIP_DIR/manager-02.container-id"
MANAGER_03_ID="$(docker run -d --privileged --name "$MANAGER_03_CONTAINER" --hostname manager-03 --network "$NETWORK_NAME" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_03_ID" >"$OWNERSHIP_DIR/manager-03.container-id"

wait_dind "$MANAGER_01_CONTAINER"
wait_dind "$MANAGER_02_CONTAINER"
wait_dind "$MANAGER_03_CONTAINER"

MANAGER_01_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_01_CONTAINER")"
MANAGER_02_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_02_CONTAINER")"
MANAGER_03_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_03_CONTAINER")"

[[ -n "$MANAGER_01_IP" && -n "$MANAGER_02_IP" && -n "$MANAGER_03_IP" ]] \
  || fail "failed to resolve manager network addresses"

log "initializing three-manager Swarm"
docker exec "$MANAGER_01_CONTAINER" docker swarm init --advertise-addr "$MANAGER_01_IP" >"$LOG_DIR/swarm-init.log"
MANAGER_TOKEN="$(docker exec "$MANAGER_01_CONTAINER" docker swarm join-token -q manager)"
[[ -n "$MANAGER_TOKEN" ]] || fail "failed to read manager join token"

docker exec "$MANAGER_02_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_02_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-02-join.log"
docker exec "$MANAGER_03_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_03_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-03-join.log"

wait_three_managers_ready "$MANAGER_01_CONTAINER" "$LOG_DIR/topology-before-pressure.txt"

LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-before-pressure.txt")"
TARGET_MANAGER="$(awk -F'|' '$4 == "Reachable" {print $1; exit}' "$LOG_DIR/topology-before-pressure.txt")"
[[ -n "$LEADER" && -n "$TARGET_MANAGER" ]] || fail "leader or contention target was not observed"
[[ "$LEADER" != "$TARGET_MANAGER" ]] || fail "contention target unexpectedly equals leader"

LEADER_CONTAINER="$(container_for_hostname "$LEADER")" || fail "unknown leader hostname: $LEADER"
TARGET_CONTAINER="$(container_for_hostname "$TARGET_MANAGER")" || fail "unknown target hostname: $TARGET_MANAGER"
TARGET_NODE_ID="$(docker exec "$TARGET_CONTAINER" docker info --format '{{.Swarm.NodeID}}')"
CLUSTER_ID="$(docker exec "$TARGET_CONTAINER" docker info --format '{{.Swarm.Cluster.ID}}')"
[[ -n "$TARGET_NODE_ID" && -n "$CLUSTER_ID" ]] || fail "failed to resolve target manager identity"

log "installing Agent and pressure helper on $TARGET_MANAGER"
docker cp "$AGENT_BINARY" "$TARGET_CONTAINER:/usr/local/bin/docklane-agent"
docker cp "$PRESSURE_BINARY" "$TARGET_CONTAINER:/usr/local/bin/docklane-resource-pressure"
docker exec "$TARGET_CONTAINER" chmod 0755 /usr/local/bin/docklane-agent /usr/local/bin/docklane-resource-pressure
docker exec "$TARGET_CONTAINER" sh -c '
  DOCKER_HOST=unix:///var/run/docker.sock \
  DOCKLANE_AGENT_INSECURE_DEV=true \
  DOCKLANE_AGENT_ADDR=127.0.0.1:9443 \
  /usr/local/bin/docklane-agent >/var/log/docklane-agent.log 2>&1 &
'

wait_agent_identity "$TARGET_CONTAINER" "$LOG_DIR/target-identity-before-pressure.json"
assert_agent_identity \
  "$TARGET_CONTAINER" \
  "$CLUSTER_ID" \
  "$TARGET_NODE_ID" \
  "$LOG_DIR/target-identity-before-pressure.json"
assert_agent_health "$TARGET_CONTAINER" "$LOG_DIR/target-health-before-pressure.json"

log "constraining $TARGET_MANAGER to $PRESSURE_CPUS CPUs and $PRESSURE_MEMORY_LIMIT memory"
docker update \
  --cpus "$PRESSURE_CPUS" \
  --memory "$PRESSURE_MEMORY_LIMIT" \
  --memory-swap "$PRESSURE_MEMORY_LIMIT" \
  "$TARGET_CONTAINER" >"$LOG_DIR/resource-limit-update.log"
docker inspect "$TARGET_CONTAINER" \
  --format '{{json .HostConfig.Resources}}' \
  >"$LOG_DIR/resource-limits.json"

log "starting CPU and memory pressure on $TARGET_MANAGER"
docker exec "$TARGET_CONTAINER" sh -c \
  "/usr/local/bin/docklane-resource-pressure --memory-mib $PRESSURE_MEMORY_MIB --cpu-workers $PRESSURE_WORKERS --duration $PRESSURE_DURATION >/var/log/docklane-resource-pressure.log 2>&1 &"

for _ in {1..30}; do
  if docker exec "$TARGET_CONTAINER" grep -q '^READY ' /var/log/docklane-resource-pressure.log 2>/dev/null; then
    break
  fi
  sleep 1
done

docker exec "$TARGET_CONTAINER" grep '^READY ' /var/log/docklane-resource-pressure.log \
  >"$LOG_DIR/resource-pressure-ready.txt" \
  || fail "resource pressure helper did not become ready"

for sample in 1 2 3; do
  log "capturing contention sample $sample"

  docker exec "$TARGET_CONTAINER" pidof docklane-resource-pressure \
    >"$LOG_DIR/resource-pressure-pid-$sample.txt" \
    || fail "resource pressure process exited before sample $sample"

  assert_three_managers_ready \
    "$LEADER_CONTAINER" \
    "$LOG_DIR/topology-under-pressure-$sample.txt"

  target_manager_status="$(awk -F'|' -v target="$TARGET_MANAGER" '$1 == target {print $4}' "$LOG_DIR/topology-under-pressure-$sample.txt")"
  [[ "$target_manager_status" == "Reachable" ]] \
    || fail "$TARGET_MANAGER lost manager reachability under pressure: $target_manager_status"

  timeout 5 docker exec "$TARGET_CONTAINER" docker info --format '{{.Swarm.ControlAvailable}}' \
    >"$LOG_DIR/target-control-available-$sample.txt"
  [[ "$(cat "$LOG_DIR/target-control-available-$sample.txt")" == "true" ]] \
    || fail "$TARGET_MANAGER lost Swarm control availability under pressure"

  assert_agent_health \
    "$TARGET_CONTAINER" \
    "$LOG_DIR/target-health-under-pressure-$sample.json"
  assert_agent_identity \
    "$TARGET_CONTAINER" \
    "$CLUSTER_ID" \
    "$TARGET_NODE_ID" \
    "$LOG_DIR/target-identity-under-pressure-$sample.json"

  docker stats --no-stream \
    --format '{{json .}}' \
    "$TARGET_CONTAINER" \
    >"$LOG_DIR/outer-container-stats-$sample.json"

  sleep 3
done

log "waiting for pressure helper to finish"
for _ in {1..60}; do
  if ! docker exec "$TARGET_CONTAINER" pidof docklane-resource-pressure >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if docker exec "$TARGET_CONTAINER" pidof docklane-resource-pressure >/dev/null 2>&1; then
  fail "resource pressure helper did not finish"
fi

docker exec "$TARGET_CONTAINER" cat /var/log/docklane-resource-pressure.log \
  >"$LOG_DIR/resource-pressure.log"
grep -q '^DONE ' "$LOG_DIR/resource-pressure.log" \
  || fail "resource pressure helper did not complete normally"

wait_three_managers_ready "$LEADER_CONTAINER" "$LOG_DIR/topology-after-pressure.txt"
assert_agent_health "$TARGET_CONTAINER" "$LOG_DIR/target-health-after-pressure.json"
assert_agent_identity \
  "$TARGET_CONTAINER" \
  "$CLUSTER_ID" \
  "$TARGET_NODE_ID" \
  "$LOG_DIR/target-identity-after-pressure.json"

cat >"$LOG_DIR/resource-contention-summary.txt" <<SUMMARY
three-manager bootstrap: PASS
non-leader manager constrained: PASS
CPU pressure active across samples: PASS
resident memory pressure active: PASS
manager quorum retained: PASS
stressed manager remained Reachable: PASS
stressed manager control-plane read remained available: PASS
stressed manager Agent health remained available: PASS
stressed manager Agent identity remained stable: PASS
post-pressure recovery: PASS
leader: $LEADER
stressed manager: $TARGET_MANAGER
CPU limit: $PRESSURE_CPUS
memory limit: $PRESSURE_MEMORY_LIMIT
pressure memory MiB: $PRESSURE_MEMORY_MIB
pressure workers: $PRESSURE_WORKERS
pressure duration: $PRESSURE_DURATION
SUMMARY

log "manager resource contention operational readiness scenario passed"
cat "$LOG_DIR/resource-contention-summary.txt"
