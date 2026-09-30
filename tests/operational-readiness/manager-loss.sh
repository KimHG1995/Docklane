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
  docker exec "$observer" docker node ls     --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}'     >"$output"
}

wait_three_managers_ready() {
  local observer="$1"
  local output="$2"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local total ready_active leaders reachable
      total="$(wc -l <"$output" | tr -d ' ')"
      ready_active="$(grep -c '|Ready|Active|' "$output" || true)"
      leaders="$(grep -c '|Leader$' "$output" || true)"
      reachable="$(grep -c '|Reachable$' "$output" || true)"
      if [[ "$total" == "3" && "$ready_active" == "3" && "$leaders" == "1" && "$reachable" == "2" ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "three-manager Swarm did not converge to 3 Ready/Active managers with one leader"
}

container_for_hostname() {
  case "$1" in
    manager-01) printf '%s\n' "$MANAGER_01_CONTAINER" ;;
    manager-02) printf '%s\n' "$MANAGER_02_CONTAINER" ;;
    manager-03) printf '%s\n' "$MANAGER_03_CONTAINER" ;;
    *) return 1 ;;
  esac
}

wait_nonleader_loss() {
  local observer="$1"
  local expected_leader="$2"
  local failed_manager="$3"
  local output="$4"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local leader ready_managers failed_status failed_manager_status
      leader="$(awk -F'|' '$4 == "Leader" {print $1}' "$output")"
      ready_managers="$(awk -F'|' '$2 == "Ready" && $3 == "Active" && ($4 == "Leader" || $4 == "Reachable") {count++} END {print count+0}' "$output")"
      failed_status="$(awk -F'|' -v failed="$failed_manager" '$1 == failed {print $2}' "$output")"
      failed_manager_status="$(awk -F'|' -v failed="$failed_manager" '$1 == failed {print $4}' "$output")"

      if [[ "$leader" == "$expected_leader" ]] &&
         [[ "$ready_managers" == "2" ]] &&
         [[ -n "$failed_status" && "$failed_status" != "Ready" ]] &&
         [[ "$failed_manager_status" == "Unreachable" ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "non-leader manager loss was not observed without leader change"
}

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

[[ -n "$MANAGER_01_IP" && -n "$MANAGER_02_IP" && -n "$MANAGER_03_IP" ]] || fail "failed to resolve manager network addresses"

log "initializing manager-01 Swarm"
docker exec "$MANAGER_01_CONTAINER" docker swarm init --advertise-addr "$MANAGER_01_IP" >"$LOG_DIR/swarm-init.log"
MANAGER_TOKEN="$(docker exec "$MANAGER_01_CONTAINER" docker swarm join-token -q manager)"
[[ -n "$MANAGER_TOKEN" ]] || fail "failed to read manager join token"

log "joining manager-02 and manager-03"
docker exec "$MANAGER_02_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_02_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-02-join.log"
docker exec "$MANAGER_03_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_03_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-03-join.log"

wait_three_managers_ready "$MANAGER_01_CONTAINER" "$LOG_DIR/topology-before-loss.txt"

LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-before-loss.txt")"
FAILED_MANAGER="$(awk -F'|' '$4 == "Reachable" {print $1; exit}' "$LOG_DIR/topology-before-loss.txt")"
[[ -n "$LEADER" && -n "$FAILED_MANAGER" ]] || fail "leader or reachable manager was not observed"
[[ "$FAILED_MANAGER" != "$LEADER" ]] || fail "manager-loss target unexpectedly equals leader"

LEADER_CONTAINER="$(container_for_hostname "$LEADER")" || fail "unknown leader hostname: $LEADER"
FAILED_CONTAINER="$(container_for_hostname "$FAILED_MANAGER")" || fail "unknown manager hostname: $FAILED_MANAGER"

log "stopping non-leader manager $FAILED_MANAGER while leader remains $LEADER"
docker stop "$FAILED_CONTAINER" >"$LOG_DIR/manager-stop.log"

wait_nonleader_loss "$LEADER_CONTAINER" "$LEADER" "$FAILED_MANAGER" "$LOG_DIR/topology-after-manager-loss.txt"

CONTROL_AVAILABLE="$(docker exec "$LEADER_CONTAINER" docker info --format '{{.Swarm.ControlAvailable}}')"
[[ "$CONTROL_AVAILABLE" == "true" ]] || fail "leader lost Swarm control availability after one manager loss"

log "restarting non-leader manager $FAILED_MANAGER"
docker start "$FAILED_CONTAINER" >"$LOG_DIR/manager-restart.log"
wait_dind "$FAILED_CONTAINER"
wait_three_managers_ready "$LEADER_CONTAINER" "$LOG_DIR/topology-after-recovery.txt"

RECOVERED_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-after-recovery.txt")"
[[ "$RECOVERED_LEADER" == "$LEADER" ]] || fail "leader changed during non-leader manager loss/recovery: before=$LEADER after=$RECOVERED_LEADER"

cat >"$LOG_DIR/manager-loss-summary.txt" <<EOF
three-manager bootstrap: PASS
non-leader manager loss observed: PASS
leader continuity: PASS
quorum retained at 2/3: PASS
manager recovery: PASS
leader: $LEADER
failed manager: $FAILED_MANAGER
recovered leader: $RECOVERED_LEADER
EOF

log "manager-loss operational readiness scenario passed"
cat "$LOG_DIR/manager-loss-summary.txt"
