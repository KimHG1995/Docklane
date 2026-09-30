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
  docker exec "$observer" docker node ls \
    --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' \
    >"$output"
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

wait_quorum_lost() {
  local survivor="$1"
  local stdout_file="$2"
  local stderr_file="$3"

  for _ in {1..120}; do
    if timeout 5 docker exec "$survivor" docker node ls \
      --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' \
      >"$stdout_file" 2>"$stderr_file"; then
      sleep 1
      continue
    fi
    return 0
  done

  fail "manager control plane remained available after quorum was reduced to 1/3"
}

wait_two_manager_quorum() {
  local observer="$1"
  local output="$2"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local ready_control leaders unavailable
      ready_control="$(awk -F'|' '$2 == "Ready" && $3 == "Active" && ($4 == "Leader" || $4 == "Reachable") {count++} END {print count+0}' "$output")"
      leaders="$(grep -c '|Leader$' "$output" || true)"
      unavailable="$(awk -F'|' '$2 != "Ready" || $4 == "Unreachable" {count++} END {print count+0}' "$output")"
      if [[ "$ready_control" == "2" && "$leaders" == "1" && "$unavailable" -ge 1 ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "Swarm quorum did not recover after restoring a second manager"
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

wait_three_managers_ready "$MANAGER_01_CONTAINER" "$LOG_DIR/topology-before-quorum-loss.txt"

LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-before-quorum-loss.txt")"
[[ -n "$LEADER" ]] || fail "leader was not observed"
SURVIVOR_CONTAINER="$(container_for_hostname "$LEADER")" || fail "unknown leader hostname: $LEADER"
SURVIVOR_NODE_ID="$(docker exec "$SURVIVOR_CONTAINER" docker node inspect self --format '{{.ID}}')"
[[ -n "$SURVIVOR_NODE_ID" ]] || fail "failed to resolve surviving leader node ID"

mapfile -t FOLLOWERS < <(awk -F'|' '$4 == "Reachable" {print $1}' "$LOG_DIR/topology-before-quorum-loss.txt")
[[ "${#FOLLOWERS[@]}" == "2" ]] || fail "expected exactly two reachable followers"

FOLLOWER_ONE="${FOLLOWERS[0]}"
FOLLOWER_TWO="${FOLLOWERS[1]}"
FOLLOWER_ONE_CONTAINER="$(container_for_hostname "$FOLLOWER_ONE")"
FOLLOWER_TWO_CONTAINER="$(container_for_hostname "$FOLLOWER_TWO")"

log "stopping both follower managers: $FOLLOWER_ONE, $FOLLOWER_TWO"
docker stop "$FOLLOWER_ONE_CONTAINER" >"$LOG_DIR/follower-one-stop.log"
docker stop "$FOLLOWER_TWO_CONTAINER" >"$LOG_DIR/follower-two-stop.log"

wait_quorum_lost \
  "$SURVIVOR_CONTAINER" \
  "$LOG_DIR/quorum-loss-node-ls.out" \
  "$LOG_DIR/quorum-loss-node-ls.err"

CONTROL_AVAILABLE="$(docker exec "$SURVIVOR_CONTAINER" docker info --format '{{.Swarm.ControlAvailable}}')"
[[ "$CONTROL_AVAILABLE" == "true" ]] || fail "surviving manager no longer reports manager control capability"

if timeout 5 docker exec "$SURVIVOR_CONTAINER" docker node update \
  --label-add docklane.quorum-loss-probe=unexpected \
  "$SURVIVOR_NODE_ID" \
  >"$LOG_DIR/quorum-loss-write.out" 2>"$LOG_DIR/quorum-loss-write.err"; then
  fail "control-plane write unexpectedly succeeded with only 1/3 managers"
fi

log "restoring one follower to recover quorum: $FOLLOWER_ONE"
docker start "$FOLLOWER_ONE_CONTAINER" >"$LOG_DIR/follower-one-restart.log"
wait_dind "$FOLLOWER_ONE_CONTAINER"

wait_two_manager_quorum "$SURVIVOR_CONTAINER" "$LOG_DIR/topology-after-quorum-recovery.txt"

docker exec "$SURVIVOR_CONTAINER" docker node update \
  --label-add docklane.quorum-recovery=ok \
  "$SURVIVOR_NODE_ID" \
  >"$LOG_DIR/quorum-recovery-write.log"

RECOVERY_LABEL="$(docker exec "$SURVIVOR_CONTAINER" docker node inspect "$SURVIVOR_NODE_ID" --format '{{index .Spec.Labels "docklane.quorum-recovery"}}')"
[[ "$RECOVERY_LABEL" == "ok" ]] || fail "control-plane write did not persist after quorum recovery"

log "restoring final follower: $FOLLOWER_TWO"
docker start "$FOLLOWER_TWO_CONTAINER" >"$LOG_DIR/follower-two-restart.log"
wait_dind "$FOLLOWER_TWO_CONTAINER"
wait_three_managers_ready "$SURVIVOR_CONTAINER" "$LOG_DIR/topology-after-full-recovery.txt"

RECOVERED_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-after-full-recovery.txt")"
[[ -n "$RECOVERED_LEADER" ]] || fail "leader missing after full quorum recovery"

cat >"$LOG_DIR/quorum-loss-summary.txt" <<EOF
three-manager bootstrap: PASS
quorum loss at 1/3 observed: PASS
control-plane read unavailable without quorum: PASS
control-plane write blocked without quorum: PASS
quorum recovery at 2/3: PASS
control-plane write restored at 2/3: PASS
full manager recovery: PASS
surviving manager: $LEADER
first restored manager: $FOLLOWER_ONE
second restored manager: $FOLLOWER_TWO
recovered leader: $RECOVERED_LEADER
EOF

log "quorum-loss operational readiness scenario passed"
cat "$LOG_DIR/quorum-loss-summary.txt"
