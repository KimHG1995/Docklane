#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-${RUNNER_TEMP:-/tmp}/docklane-swarm-backup-private-${GITHUB_RUN_ID:-local}}"
NET="docklane-or-manager-net"
M1="docklane-or-manager-01"
M2="docklane-or-manager-02"
M3="docklane-or-manager-03"
IMG="${DOCKLANE_OR_DIND_IMAGE:-docker:28-dind}"
SERVICE="docklane-backup-marker-service"
CONFIG="docklane-backup-marker-config"

export DOCKLANE_OR_LOG_DIR="$LOG"

log(){ printf '[operational-readiness] %s\n' "$*"; }
fail(){ printf '[operational-readiness] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup(){
  bash "$ROOT/tests/operational-readiness/cleanup.sh" || true
  case "$(basename "$BACKUP")" in
    docklane-swarm-backup-private-*) rm -rf -- "$BACKUP" ;;
  esac
}

wait_docker(){
  for _ in {1..120}; do docker exec "$1" docker info >/dev/null 2>&1 && return 0; sleep 1; done
  fail "Docker daemon not ready: $1"
}

ip(){
  docker inspect --format "{{with index .NetworkSettings.Networks \"$NET\"}}{{.IPAddress}}{{end}}" "$1"
}

topology(){
  docker exec "$1" docker node ls \
    --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' >"$2"
}

wait_three(){
  for _ in {1..120}; do
    if topology "$1" "$2" 2>/dev/null; then
      local ready leaders followers
      ready="$(awk -F'|' '$2=="Ready" && $3=="Active" {n++} END{print n+0}' "$2")"
      leaders="$(awk -F'|' '$4=="Leader" {n++} END{print n+0}' "$2")"
      followers="$(awk -F'|' '$4=="Reachable" {n++} END{print n+0}' "$2")"
      [[ "$ready" == 3 && "$leaders" == 1 && "$followers" == 2 ]] && return 0
    fi
    sleep 1
  done
  fail "three-manager Swarm did not converge"
}

wait_manager_count(){
  local observer="$1" expected="$2" output="$3"
  for _ in {1..120}; do
    if topology "$observer" "$output" 2>/dev/null; then
      local ready leaders followers
      ready="$(awk -F'|' '$2=="Ready" && $3=="Active" && ($4=="Leader" || $4=="Reachable") {n++} END{print n+0}' "$output")"
      leaders="$(awk -F'|' '$4=="Leader" {n++} END{print n+0}' "$output")"
      followers="$(awk -F'|' '$4=="Reachable" {n++} END{print n+0}' "$output")"
      [[ "$ready" == "$expected" && "$leaders" == 1 && "$followers" == $((expected - 1)) ]] && return 0
    fi
    sleep 1
  done
  fail "$expected-manager Swarm did not converge"
}

wait_restored_manager_count(){
  local observer="$1" expected="$2" output="$3"
  for attempt in {1..600}; do
    if topology "$observer" "$output" 2>/dev/null; then
      local ready leaders followers
      ready="$(awk -F'|' '$2=="Ready" && $3=="Active" && ($4=="Leader" || $4=="Reachable") {n++} END{print n+0}' "$output")"
      leaders="$(awk -F'|' '$4=="Leader" {n++} END{print n+0}' "$output")"
      followers="$(awk -F'|' '$4=="Reachable" {n++} END{print n+0}' "$output")"
      [[ "$ready" == "$expected" && "$leaders" == 1 && "$followers" == $((expected - 1)) ]] && return 0
    fi

    if (( attempt % 30 == 0 )); then
      cp "$output" "$LOG/restored-manager-convergence-${expected}-${attempt}s.txt" 2>/dev/null || true
    fi
    sleep 1
  done

  docker exec "$observer" docker node ls >"$LOG/restored-manager-timeout-node-ls.txt" 2>&1 || true
  node_ids="$(docker exec "$observer" docker node ls -q 2>/dev/null || true)"
  if [[ -n "$node_ids" ]]; then
    docker exec "$observer" docker node inspect $node_ids       >"$LOG/restored-manager-timeout-node-inspect.json" 2>&1 || true
  fi
  for container in "$M1" "$M2" "$M3"; do
    docker inspect "$container" >/dev/null 2>&1 || continue
    docker exec "$container" docker info       >"$LOG/restored-manager-timeout-${container}-docker-info.txt" 2>&1 || true
    docker logs "$container"       >"$LOG/restored-manager-timeout-${container}-dockerd.log" 2>&1 || true
  done

  fail "$expected-manager restored Swarm did not converge within 10 minutes"
}

record(){
  printf '%s\n' "$2" >"$OWN/$1.container-id"
}

cleanup_stale_restored_nodes(){
  local observer="$1" restored_node_id="$2"
  local before="$LOG/topology-before-stale-node-cleanup.txt"
  local after="$LOG/topology-after-stale-node-cleanup.txt"

  docker exec "$observer" docker node ls \
    --format '{{.ID}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' >"$before"

  local node_id role status hostname manager_status
  while IFS= read -r node_id; do
    [[ -n "$node_id" ]] || continue
    [[ "$node_id" == "$restored_node_id" ]] && continue

    IFS='|' read -r role status hostname manager_status < <(
      docker exec "$observer" docker node inspect "$node_id" \
        --format '{{.Spec.Role}}|{{.Status.State}}|{{.Description.Hostname}}|{{if .ManagerStatus}}{{.ManagerStatus.Reachability}}{{end}}'
    )

    [[ "$status" != "ready" ]] \
      || fail "refusing to remove unexpected Ready restored node $hostname ($node_id)"

    if [[ "$role" == "manager" && -n "$manager_status" ]]; then
      fail "refusing to remove stale manager still present in Raft memberlist: $hostname ($node_id)"
    fi

    printf '%s|%s|%s|%s\n' "$node_id" "$role" "$status" "${manager_status:-not-in-raft}" \
      >>"$LOG/stale-node-removal-candidates.txt"
    docker exec "$observer" docker node rm --force "$node_id" \
      >>"$LOG/stale-node-remove.log"
  done < <(docker exec "$observer" docker node ls -q)

  for _ in {1..60}; do
    if docker exec "$observer" docker node ls \
      --format '{{.ID}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' >"$after" 2>/dev/null; then
      local total current
      total="$(wc -l <"$after" | tr -d ' ')"
      current="$(awk -F'|' -v id="$restored_node_id" \
        '$1==id && $2=="Ready" && $3=="Active" && $4=="Leader" {print $1}' "$after")"
      [[ "$total" == 1 && "$current" == "$restored_node_id" ]] && return 0
    fi
    sleep 1
  done

  fail "restored Swarm did not converge to one canonical manager after stale node cleanup"
}

start_fresh(){
  local name="$1" host="$2" id
  id="$(docker run -d --privileged --name "$name" --hostname "$host" \
    --network "$NET" -e DOCKER_TLS_CERTDIR= "$IMG")"
  record "$host" "$id"
  wait_docker "$name"
}

verify_markers(){
  local mgr="$1" service_id="$2" config_id="$3" prefix="$4"
  [[ "$(docker exec "$mgr" docker service inspect "$SERVICE" --format '{{.ID}}')" == "$service_id" ]] \
    || fail "service ID not preserved"
  [[ "$(docker exec "$mgr" docker config inspect "$CONFIG" --format '{{.ID}}')" == "$config_id" ]] \
    || fail "config ID not preserved"
  [[ "$(docker exec "$mgr" docker service inspect "$SERVICE" --format '{{.Spec.Mode.Replicated.Replicas}}')" == 0 ]] \
    || fail "service replica target changed"
  docker exec "$mgr" docker service inspect "$SERVICE" >"$LOG/$prefix-service.json"
  docker exec "$mgr" docker config inspect "$CONFIG" >"$LOG/$prefix-config.json"
}

for n in "$M1" "$M2" "$M3"; do
  docker inspect "$n" >/dev/null 2>&1 && fail "container already exists: $n"
done
docker network inspect "$NET" >/dev/null 2>&1 && fail "network already exists: $NET"

mkdir -p "$LOG" "$OWN"
case "$(basename "$BACKUP")" in
  docklane-swarm-backup-private-*) ;;
  *) fail "unsafe private backup path" ;;
esac
rm -rf "$BACKUP"; mkdir -p "$BACKUP"; chmod 0700 "$BACKUP"
trap cleanup EXIT

log "creating source three-manager Swarm"
NET_ID="$(docker network create "$NET")"
printf '%s\n' "$NET_ID" >"$OWN/manager-network.network-id"
start_fresh "$M1" manager-01
start_fresh "$M2" manager-02
start_fresh "$M3" manager-03

IP1="$(ip "$M1")"; IP2="$(ip "$M2")"; IP3="$(ip "$M3")"
docker exec "$M1" docker swarm init --advertise-addr "$IP1" >"$LOG/swarm-init.log"
TOKEN="$(docker exec "$M1" docker swarm join-token -q manager)"
docker exec "$M2" docker swarm join --token "$TOKEN" --advertise-addr "$IP2" "$IP1:2377" >"$LOG/manager-02-join.log"
docker exec "$M3" docker swarm join --token "$TOKEN" --advertise-addr "$IP3" "$IP1:2377" >"$LOG/manager-03-join.log"
wait_three "$M1" "$LOG/topology-before-backup.txt"
ORIGINAL_CLUSTER="$(docker exec "$M1" docker info --format '{{.Swarm.Cluster.ID}}')"

log "creating persisted Raft markers"
CONFIG_ID="$(printf 'docklane-backup-marker-v1\n' | docker exec -i "$M1" docker config create "$CONFIG" -)"
SERVICE_ID="$(docker exec "$M1" docker service create --quiet --name "$SERVICE" \
  --replicas 0 --no-resolve-image busybox:1.36 sleep 3600)"
verify_markers "$M1" "$SERVICE_ID" "$CONFIG_ID" before-backup

BACKUP_HOST="$(awk -F'|' '$4=="Reachable"{print $1; exit}' "$LOG/topology-before-backup.txt")"
case "$BACKUP_HOST" in
  manager-01) BM="$M1" ;;
  manager-02) BM="$M2" ;;
  manager-03) BM="$M3" ;;
  *) fail "no backup manager found" ;;
esac
BACKUP_IP="$(ip "$BM")"
[[ -n "$BACKUP_IP" ]] || fail "backup manager address is empty"
printf '%s\n' "$BACKUP_IP" >"$LOG/backup-manager-ip.txt"
verify_markers "$BM" "$SERVICE_ID" "$CONFIG_ID" backup-peer
docker stop "$BM" >"$LOG/backup-manager-stop.log"
[[ "$(docker inspect --format '{{.State.Running}}' "$BM")" == false ]] || fail "backup manager still running"

log "taking cold backup of /var/lib/docker/swarm"
docker run --rm --volumes-from "$BM" -v "$BACKUP:/backup" --entrypoint sh "$IMG" \
  -c 'set -eu; tar -C /var/lib/docker -cf /backup/swarm.tar swarm'
[[ -s "$BACKUP/swarm.tar" ]] || fail "backup archive missing"
tar -tf "$BACKUP/swarm.tar" >"$LOG/swarm-backup-file-list.txt"
grep -q '^swarm/raft/' "$LOG/swarm-backup-file-list.txt" || fail "Raft state missing from backup"
sha256sum "$BACKUP/swarm.tar" | awk '{print $1}' >"$LOG/swarm-backup.sha256"
printf '%s\n' "Backup bytes are excluded from artifacts and deleted during cleanup." >"$LOG/swarm-backup-handling.txt"

docker start "$BM" >"$LOG/backup-manager-restart.log"
wait_docker "$BM"
wait_three "$M1" "$LOG/topology-after-backup.txt"
verify_markers "$M1" "$SERVICE_ID" "$CONFIG_ID" after-backup

log "simulating loss of every source manager"
docker rm -fv "$M3" "$M2" "$M1" >"$LOG/source-managers-remove.log"
rm -f "$OWN/manager-01.container-id" "$OWN/manager-02.container-id" "$OWN/manager-03.container-id"

log "restoring backup into a clean manager"
RESTORE_ID="$(docker create --privileged --name "$M1" --hostname manager-01 \
  --network "$NET" --ip "$BACKUP_IP" -e DOCKER_TLS_CERTDIR= "$IMG")"
record manager-01 "$RESTORE_ID"
docker run --rm --volumes-from "$M1" -v "$BACKUP:/backup:ro" --entrypoint sh "$IMG" \
  -c 'set -eu; rm -rf /var/lib/docker/swarm; tar -C /var/lib/docker -xf /backup/swarm.tar'
docker start "$M1" >"$LOG/restore-manager-start.log"
wait_docker "$M1"
RESTORE_IP="$(ip "$M1")"
[[ "$RESTORE_IP" == "$BACKUP_IP" ]] \
  || fail "restored manager address changed: expected $BACKUP_IP, got $RESTORE_IP"

docker exec "$M1" docker swarm init --force-new-cluster --advertise-addr "$RESTORE_IP" \
  >"$LOG/force-new-cluster.log"
[[ "$(docker exec "$M1" docker info --format '{{.Swarm.ControlAvailable}}')" == true ]] \
  || fail "restored manager has no control"
RESTORED_CLUSTER="$(docker exec "$M1" docker info --format '{{.Swarm.Cluster.ID}}')"
printf '%s\n' "$ORIGINAL_CLUSTER" >"$LOG/original-cluster-id.txt"
printf '%s\n' "$RESTORED_CLUSTER" >"$LOG/restored-cluster-id.txt"
verify_markers "$M1" "$SERVICE_ID" "$CONFIG_ID" after-restore

RESTORED_NODE_ID="$(docker exec "$M1" docker info --format '{{.Swarm.NodeID}}')"
[[ -n "$RESTORED_NODE_ID" ]] || fail "restored manager has no canonical node ID"
printf '%s\n' "$RESTORED_NODE_ID" >"$LOG/restored-node-id.txt"

RESTORED_MANAGER_ADDR="$(docker exec "$M1" docker node inspect "$RESTORED_NODE_ID" --format '{{.ManagerStatus.Addr}}')"
printf '%s\n' "$RESTORED_MANAGER_ADDR" >"$LOG/restored-manager-address.txt"
[[ "$RESTORED_MANAGER_ADDR" == "$RESTORE_IP:2377" ]] \
  || fail "restored Raft manager address mismatch: expected $RESTORE_IP:2377, got $RESTORED_MANAGER_ADDR"

log "removing stale nodes from restored snapshot"
cleanup_stale_restored_nodes "$M1" "$RESTORED_NODE_ID"
verify_markers "$M1" "$SERVICE_ID" "$CONFIG_ID" after-stale-node-cleanup

log "joining fresh nodes as workers before manager promotion"
start_fresh "$M2" manager-02
start_fresh "$M3" manager-03
IP2="$(ip "$M2")"; IP3="$(ip "$M3")"
WORKER_TOKEN="$(docker exec "$M1" docker swarm join-token -q worker)"

join_worker(){
  local container="$1" addr="$2" output="$3"
  if docker exec "$container" docker swarm join --token "$WORKER_TOKEN" \
    --advertise-addr "$addr" "$RESTORE_IP:2377" >"$output" 2>&1; then
    return 0
  fi

  if grep -q 'attempt to join the swarm will continue in the background' "$output"; then
    log "$container worker join is continuing in background"
    return 0
  fi

  cat "$output" >&2
  fail "$container failed to join restored Swarm as worker"
}

wait_worker_ready(){
  local container="$1" observer="$2" output="$3"
  for _ in {1..120}; do
    local state node_id node_state node_role
    state="$(docker exec "$container" docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
    node_id="$(docker exec "$container" docker info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
    if [[ "$state" == active && -n "$node_id" ]]; then
      if docker exec "$observer" docker node inspect "$node_id" \
        --format '{{.Status.State}}|{{.Spec.Role}}' >"$output" 2>/dev/null; then
        IFS='|' read -r node_state node_role <"$output"
        if [[ "$node_state" == ready && "$node_role" == worker ]]; then
          printf '%s\n' "$node_id"
          return 0
        fi
      fi
    fi
    sleep 1
  done
  fail "$container did not become a Ready worker in restored Swarm"
}

join_worker "$M2" "$IP2" "$LOG/restored-worker-02-join.log"
M2_NODE_ID="$(wait_worker_ready "$M2" "$M1" "$LOG/restored-worker-02-state.txt")"
join_worker "$M3" "$IP3" "$LOG/restored-worker-03-join.log"
M3_NODE_ID="$(wait_worker_ready "$M3" "$M1" "$LOG/restored-worker-03-state.txt")"

log "promoting manager-02 and waiting for two-manager convergence"
docker exec "$M1" docker node promote "$M2_NODE_ID" >"$LOG/restored-manager-02-promote.log"
wait_restored_manager_count "$M1" 2 "$LOG/topology-after-first-manager-restore.txt"

log "promoting manager-03 and restoring three-manager operating capacity"
docker exec "$M1" docker node promote "$M3_NODE_ID" >"$LOG/restored-manager-03-promote.log"
wait_restored_manager_count "$M1" 3 "$LOG/topology-after-restore.txt"
verify_markers "$M1" "$SERVICE_ID" "$CONFIG_ID" after-capacity-restore

cat >"$LOG/swarm-backup-restore-summary.txt" <<SUMMARY
source three-manager cluster: PASS
cold backup while manager stopped: PASS
Raft state present in backup: PASS
source cluster resumed after backup: PASS
all source managers removed for disaster simulation: PASS
backup restored to clean manager: PASS
force-new-cluster recovery: PASS
service ID/spec preserved: PASS
config ID preserved: PASS
control availability restored: PASS
stale restored node records removed: PASS
fresh nodes joined as workers: PASS
manager-02 promoted and converged: PASS
manager-03 promoted and three-manager capacity restored: PASS
backup manager: $BACKUP_HOST
backup manager IP: $BACKUP_IP
restored manager address: $RESTORED_MANAGER_ADDR
original cluster ID: $ORIGINAL_CLUSTER
restored cluster ID: $RESTORED_CLUSTER
service ID: $SERVICE_ID
config ID: $CONFIG_ID
SUMMARY

log "Swarm backup/restore drill passed"
cat "$LOG/swarm-backup-restore-summary.txt"
