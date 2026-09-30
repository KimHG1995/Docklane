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

wait_leader_failover() {
  local observer="$1"
  local old_leader="$2"
  local output="$3"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local leader ready_managers old_status new_leader
      leader="$(awk -F'|' '$4 == "Leader" {print $1}' "$output")"
      ready_managers="$(awk -F'|' '$2 == "Ready" && $3 == "Active" && ($4 == "Leader" || $4 == "Reachable") {count++} END {print count+0}' "$output")"
      old_status="$(awk -F'|' -v old="$old_leader" '$1 == old {print $2}' "$output")"
      new_leader="$leader"

      if [[ -n "$new_leader" ]] &&
         [[ "$new_leader" != "$old_leader" ]] &&
         [[ "$ready_managers" == "2" ]] &&
         [[ -n "$old_status" && "$old_status" != "Ready" ]]; then
        printf '%s\n' "$new_leader"
        return 0
      fi
    fi
    sleep 1
  done

  fail "surviving managers did not elect a new leader after $old_leader stopped"
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

OLD_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-before-loss.txt")"
[[ -n "$OLD_LEADER" ]] || fail "initial leader was not observed"
LEADER_CONTAINER="$(container_for_hostname "$OLD_LEADER")" || fail "unknown leader hostname: $OLD_LEADER"

for candidate in manager-01 manager-02 manager-03; do
  if [[ "$candidate" != "$OLD_LEADER" ]]; then
    OBSERVER_HOST="$candidate"
    break
  fi
done
OBSERVER_CONTAINER="$(container_for_hostname "$OBSERVER_HOST")"

log "stopping current leader $OLD_LEADER"
docker stop "$LEADER_CONTAINER" >"$LOG_DIR/leader-stop.log"

NEW_LEADER="$(wait_leader_failover "$OBSERVER_CONTAINER" "$OLD_LEADER" "$LOG_DIR/topology-after-leader-loss.txt")"

CONTROL_AVAILABLE="$(docker exec "$OBSERVER_CONTAINER" docker info --format '{{.Swarm.ControlAvailable}}')"
[[ "$CONTROL_AVAILABLE" == "true" ]] || fail "surviving manager lost Swarm control availability"

log "new leader elected: $NEW_LEADER"

log "restarting former leader $OLD_LEADER"
docker start "$LEADER_CONTAINER" >"$LOG_DIR/leader-restart.log"
wait_dind "$LEADER_CONTAINER"
wait_three_managers_ready "$OBSERVER_CONTAINER" "$LOG_DIR/topology-after-recovery.txt"

RECOVERED_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-after-recovery.txt")"
[[ -n "$RECOVERED_LEADER" ]] || fail "leader missing after former leader recovery"

cat >"$LOG_DIR/summary.txt" <<EOF
three-manager bootstrap: PASS
leader loss observed: PASS
quorum retained at 2/3: PASS
new leader election: PASS
former leader recovery: PASS
old leader: $OLD_LEADER
failover leader: $NEW_LEADER
recovered leader: $RECOVERED_LEADER
EOF

log "leader-loss operational readiness scenario passed"
cat "$LOG_DIR/summary.txt"
