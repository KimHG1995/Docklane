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
cmp "$LOG_DIR/three-node-topology.txt" "$LOG_DIR/manager-api-node-ls.txt"   || fail "manager Docker API view differs between in-container and host-loopback access"

cat >"$LOG_DIR/three-node-summary.txt" <<EOF
manager-01 Ready/Active/Leader: PASS
worker-01 Ready/Active: PASS
worker-02 Ready/Active: PASS
manager Docker API loopback access: PASS
topology node count: 3
EOF

log "three-node topology PoC passed"
cat "$LOG_DIR/three-node-summary.txt"
