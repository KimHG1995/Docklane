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

ip_for_hostname() {
  case "$1" in
    manager-01) printf '%s\n' "$MANAGER_01_IP" ;;
    manager-02) printf '%s\n' "$MANAGER_02_IP" ;;
    manager-03) printf '%s\n' "$MANAGER_03_IP" ;;
    *) return 1 ;;
  esac
}

add_partition_rule() {
  local container="$1"
  local direction="$2"
  local peer_ip="$3"

  case "$direction" in
    input)
      docker exec "$container" iptables -I INPUT 1 -s "$peer_ip" -j DROP
      ;;
    output)
      docker exec "$container" iptables -I OUTPUT 1 -d "$peer_ip" -j DROP
      ;;
    *)
      fail "unknown partition rule direction: $direction"
      ;;
  esac
}

remove_partition_rule() {
  local container="$1"
  local direction="$2"
  local peer_ip="$3"

  case "$direction" in
    input)
      docker exec "$container" iptables -D INPUT -s "$peer_ip" -j DROP
      ;;
    output)
      docker exec "$container" iptables -D OUTPUT -d "$peer_ip" -j DROP
      ;;
    *)
      fail "unknown partition rule direction: $direction"
      ;;
  esac
}

wait_partition_failover() {
  local observer="$1"
  local old_leader="$2"
  local output="$3"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local leader majority_ready isolated_manager_status
      leader="$(awk -F'|' '$4 == "Leader" {print $1}' "$output")"
      majority_ready="$(awk -F'|' -v isolated="$old_leader" '$1 != isolated && $2 == "Ready" && $3 == "Active" && ($4 == "Leader" || $4 == "Reachable") {count++} END {print count+0}' "$output")"
      isolated_manager_status="$(awk -F'|' -v isolated="$old_leader" '$1 == isolated {print $4}' "$output")"

      if [[ -n "$leader" ]] &&
         [[ "$leader" != "$old_leader" ]] &&
         [[ "$majority_ready" == "2" ]] &&
         [[ "$isolated_manager_status" == "Unreachable" ]]; then
        printf '%s\n' "$leader"
        return 0
      fi
    fi
    sleep 1
  done

  fail "majority managers did not elect a new leader after network partition"
}

wait_isolated_control_unavailable() {
  local isolated_container="$1"
  local stdout_file="$2"
  local stderr_file="$3"

  for _ in {1..120}; do
    if timeout 5 docker exec "$isolated_container" docker node ls       --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}'       >"$stdout_file" 2>"$stderr_file"; then
      sleep 1
      continue
    fi
    return 0
  done

  fail "isolated former leader retained manager control-plane reads"
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

docker exec "$MANAGER_01_CONTAINER" iptables --version >"$LOG_DIR/iptables-version.txt"

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

wait_three_managers_ready "$MANAGER_01_CONTAINER" "$LOG_DIR/topology-before-partition.txt"

OLD_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-before-partition.txt")"
[[ -n "$OLD_LEADER" ]] || fail "leader was not observed before partition"
ISOLATED_CONTAINER="$(container_for_hostname "$OLD_LEADER")" || fail "unknown leader hostname: $OLD_LEADER"
ISOLATED_NODE_ID="$(docker exec "$ISOLATED_CONTAINER" docker node inspect self --format '{{.ID}}')"
[[ -n "$ISOLATED_NODE_ID" ]] || fail "failed to resolve isolated leader node ID"

mapfile -t MAJORITY_MANAGERS < <(awk -F'|' -v leader="$OLD_LEADER" '$1 != leader {print $1}' "$LOG_DIR/topology-before-partition.txt")
[[ "${#MAJORITY_MANAGERS[@]}" == "2" ]] || fail "expected exactly two majority managers"

MAJORITY_ONE="${MAJORITY_MANAGERS[0]}"
MAJORITY_TWO="${MAJORITY_MANAGERS[1]}"
MAJORITY_ONE_CONTAINER="$(container_for_hostname "$MAJORITY_ONE")"
MAJORITY_TWO_CONTAINER="$(container_for_hostname "$MAJORITY_TWO")"
MAJORITY_ONE_IP="$(ip_for_hostname "$MAJORITY_ONE")"
MAJORITY_TWO_IP="$(ip_for_hostname "$MAJORITY_TWO")"

log "isolating current leader $OLD_LEADER from $MAJORITY_ONE and $MAJORITY_TWO"
add_partition_rule "$ISOLATED_CONTAINER" input "$MAJORITY_ONE_IP"
add_partition_rule "$ISOLATED_CONTAINER" output "$MAJORITY_ONE_IP"
add_partition_rule "$ISOLATED_CONTAINER" input "$MAJORITY_TWO_IP"
add_partition_rule "$ISOLATED_CONTAINER" output "$MAJORITY_TWO_IP"
docker exec "$ISOLATED_CONTAINER" iptables -S INPUT >"$LOG_DIR/partition-input-rules.txt"
docker exec "$ISOLATED_CONTAINER" iptables -S OUTPUT >"$LOG_DIR/partition-output-rules.txt"

NEW_LEADER="$(wait_partition_failover "$MAJORITY_ONE_CONTAINER" "$OLD_LEADER" "$LOG_DIR/topology-during-partition.txt")"
[[ "$NEW_LEADER" != "$OLD_LEADER" ]] || fail "partition did not move leadership to majority side"

wait_isolated_control_unavailable   "$ISOLATED_CONTAINER"   "$LOG_DIR/isolated-node-ls.out"   "$LOG_DIR/isolated-node-ls.err"

if timeout 5 docker exec "$ISOLATED_CONTAINER" docker node update   --label-add docklane.partition-isolated=unexpected   "$ISOLATED_NODE_ID"   >"$LOG_DIR/isolated-write.out" 2>"$LOG_DIR/isolated-write.err"; then
  fail "isolated former leader unexpectedly accepted a control-plane write"
fi

NEW_LEADER_CONTAINER="$(container_for_hostname "$NEW_LEADER")"
docker exec "$NEW_LEADER_CONTAINER" docker node update   --label-add docklane.partition-majority=ok   "$NEW_LEADER"   >"$LOG_DIR/majority-write.log"

MAJORITY_LABEL="$(docker exec "$NEW_LEADER_CONTAINER" docker node inspect "$NEW_LEADER" --format '{{index .Spec.Labels "docklane.partition-majority"}}')"
[[ "$MAJORITY_LABEL" == "ok" ]] || fail "majority control-plane write did not persist during partition"

log "restoring network connectivity for former leader $OLD_LEADER"
remove_partition_rule "$ISOLATED_CONTAINER" input "$MAJORITY_ONE_IP"
remove_partition_rule "$ISOLATED_CONTAINER" output "$MAJORITY_ONE_IP"
remove_partition_rule "$ISOLATED_CONTAINER" input "$MAJORITY_TWO_IP"
remove_partition_rule "$ISOLATED_CONTAINER" output "$MAJORITY_TWO_IP"

wait_three_managers_ready "$NEW_LEADER_CONTAINER" "$LOG_DIR/topology-after-partition-recovery.txt"

RECOVERED_LEADER="$(awk -F'|' '$4 == "Leader" {print $1}' "$LOG_DIR/topology-after-partition-recovery.txt")"
[[ -n "$RECOVERED_LEADER" ]] || fail "leader missing after partition recovery"

ISOLATED_MANAGER_STATUS="$(awk -F'|' -v isolated="$OLD_LEADER" '$1 == isolated {print $4}' "$LOG_DIR/topology-after-partition-recovery.txt")"
[[ "$ISOLATED_MANAGER_STATUS" == "Leader" || "$ISOLATED_MANAGER_STATUS" == "Reachable" ]] || fail "isolated manager did not rejoin manager quorum"

cat >"$LOG_DIR/network-partition-summary.txt" <<EOF
three-manager bootstrap: PASS
leader network isolation: PASS
majority leader re-election: PASS
isolated control-plane read unavailable: PASS
isolated control-plane write blocked: PASS
majority control-plane write available: PASS
network recovery: PASS
three-manager rejoin: PASS
isolated former leader: $OLD_LEADER
majority leader during partition: $NEW_LEADER
recovered leader: $RECOVERED_LEADER
EOF

log "network-partition operational readiness scenario passed"
cat "$LOG_DIR/network-partition-summary.txt"
