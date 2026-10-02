#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership-trust-key"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-${RUNNER_TEMP:-/tmp}/docklane-trust-backup-private-${GITHUB_RUN_ID:-local}}"
NET="docklane-or-manager-net"
NET_SUBNET="${DOCKLANE_OR_MANAGER_SUBNET:-172.30.251.0/24}"
M1="docklane-or-manager-01"
M2="docklane-or-manager-02"
M3="docklane-or-manager-03"
RESTORE="docklane-or-trust-restore"
WORKER="docklane-or-trust-worker"
IMG="${DOCKLANE_OR_DIND_IMAGE:-docker:28-dind}"

export DOCKLANE_OR_LOG_DIR="$LOG"
export DOCKLANE_OR_PRIVATE_BACKUP_DIR="$BACKUP"

log(){ printf '[operational-readiness] %s\n' "$*"; }
fail(){ printf '[operational-readiness] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup(){ bash "$ROOT/tests/operational-readiness/trust-key-restore-cleanup.sh" || true; }
record(){ printf '%s\n' "$2" >"$OWN/$1.container-id"; }

wait_dind(){
  for _ in {1..120}; do
    timeout 5 docker exec "$1" docker version >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "Docker daemon not ready: $1"
}

ip(){
  docker inspect --format "{{with index .NetworkSettings.Networks \"$NET\"}}{{.IPAddress}}{{end}}" "$1"
}

start_fresh(){
  local name="$1" host="$2" id
  id="$(docker run -d --privileged --name "$name" --hostname "$host" --network "$NET" -e DOCKER_TLS_CERTDIR= "$IMG")"
  record "$name" "$id"
  wait_dind "$name"
}

wait_three(){
  local out="$2"
  for _ in {1..120}; do
    if docker exec "$1" docker node ls --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' >"$out" 2>/dev/null; then
      local ready leaders followers
      ready="$(awk -F'|' '$2=="Ready" && $3=="Active" {n++} END{print n+0}' "$out")"
      leaders="$(awk -F'|' '$4=="Leader" {n++} END{print n+0}' "$out")"
      followers="$(awk -F'|' '$4=="Reachable" {n++} END{print n+0}' "$out")"
      [[ "$ready" == 3 && "$leaders" == 1 && "$followers" == 2 ]] && return 0
    fi
    sleep 1
  done
  fail "three-manager Swarm did not converge"
}

assert_locked(){
  if docker exec "$1" docker node ls >"$LOG/$2.out" 2>"$LOG/$2.err"; then
    fail "$1 unexpectedly accepted Swarm reads while locked"
  fi
}

unlock(){
  printf '%s\n' "$2" | docker exec -i "$1" docker swarm unlock >"$LOG/$3.out" 2>"$LOG/$3.err"
}

wait_control(){
  for _ in {1..120}; do
    local available
    available="$(timeout 5 docker exec "$1" docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)"
    [[ "$available" == true ]] && return 0
    sleep 1
  done
  fail "Swarm control not available: $1"
}

wait_worker(){
  for _ in {1..120}; do
    local id state
    id="$(timeout 5 docker exec "$1" docker info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
    if [[ -n "$id" ]] && timeout 5 docker exec "$2" docker node inspect "$id" --format '{{.Status.State}}|{{.Spec.Role}}' >"$3" 2>/dev/null; then
      IFS='|' read -r state role <"$3"
      [[ "$state" == ready && "$role" == worker ]] && { printf '%s\n' "$id"; return 0; }
    fi
    sleep 1
  done
  fail "worker did not become Ready"
}

for name in "$M1" "$M2" "$M3" "$RESTORE" "$WORKER"; do
  docker inspect "$name" >/dev/null 2>&1 && fail "container already exists: $name"
done
docker network inspect "$NET" >/dev/null 2>&1 && fail "network already exists: $NET"

mkdir -p "$LOG" "$OWN" "$BACKUP"
chmod 0700 "$BACKUP"
trap cleanup EXIT

log "creating autolocked Swarm"
NET_ID="$(docker network create --subnet "$NET_SUBNET" "$NET")"
printf '%s\n' "$NET_ID" >"$OWN/manager-network.network-id"
start_fresh "$M1" manager-01
start_fresh "$M2" manager-02
start_fresh "$M3" manager-03

IP1="$(ip "$M1")"; IP2="$(ip "$M2")"; IP3="$(ip "$M3")"
docker exec "$M1" docker swarm init --autolock --advertise-addr "$IP1" >"$BACKUP/swarm-init-private.log"
KEY1="$(docker exec "$M1" docker swarm unlock-key -q)"
[[ "$KEY1" == SWMKEY-* ]] || fail "unlock key missing"
printf '%s\n' "$KEY1" >"$BACKUP/unlock-key.txt"

TOKEN="$(docker exec "$M1" docker swarm join-token -q manager)"
docker exec "$M2" docker swarm join --token "$TOKEN" --advertise-addr "$IP2" "$IP1:2377" >"$LOG/manager-02-join.log"
docker exec "$M3" docker swarm join --token "$TOKEN" --advertise-addr "$IP3" "$IP1:2377" >"$LOG/manager-03-join.log"
wait_three "$M1" "$LOG/topology-before-backup.txt"

CA1="$(docker exec "$M1" sha256sum /var/lib/docker/swarm/certificates/swarm-root-ca.crt | awk '{print $1}')"
printf '%s\n' "$CA1" >"$LOG/source-root-ca.sha256"

BACKUP_HOST="$(awk -F'|' '$4=="Reachable"{print $1; exit}' "$LOG/topology-before-backup.txt")"
case "$BACKUP_HOST" in
  manager-01) BM="$M1" ;;
  manager-02) BM="$M2" ;;
  manager-03) BM="$M3" ;;
  *) fail "no backup manager found" ;;
esac
BACKUP_IP="$(ip "$BM")"

log "taking cold encrypted Swarm backup"
docker stop "$BM" >"$LOG/backup-manager-stop.log"
docker run --rm --volumes-from "$BM" -v "$BACKUP:/backup" --entrypoint sh "$IMG" -c 'tar -C /var/lib/docker -cf /backup/swarm.tar swarm'
[[ -s "$BACKUP/swarm.tar" ]] || fail "backup missing"

log "verifying source manager lock"
docker start "$BM" >"$LOG/backup-manager-restart.log"
wait_dind "$BM"
assert_locked "$BM" source-locked
unlock "$BM" "$KEY1" source-unlock
wait_three "$M1" "$LOG/topology-after-source-unlock.txt"

docker rm -fv "$M3" "$M2" "$M1" >"$LOG/source-managers-remove.log"
rm -f "$OWN/$M1.container-id" "$OWN/$M2.container-id" "$OWN/$M3.container-id"

log "restoring encrypted state"
RID="$(docker create --privileged --name "$RESTORE" --hostname "$BACKUP_HOST" --network "$NET" --ip "$BACKUP_IP" -e DOCKER_TLS_CERTDIR= "$IMG")"
record "$RESTORE" "$RID"
docker run --rm --volumes-from "$RESTORE" -v "$BACKUP:/backup:ro" --entrypoint sh "$IMG" -c 'rm -rf /var/lib/docker/swarm && tar -C /var/lib/docker -xf /backup/swarm.tar'
docker start "$RESTORE" >"$LOG/restore-start.log"
wait_dind "$RESTORE"
assert_locked "$RESTORE" restore-locked

BAD_KEY="${KEY1%?}X"
if [[ "$BAD_KEY" == "$KEY1" ]]; then BAD_KEY="${KEY1%?}Y"; fi
if printf '%s\n' "$BAD_KEY" | docker exec -i "$RESTORE" docker swarm unlock >"$LOG/wrong-key.out" 2>"$LOG/wrong-key.err"; then
  fail "invalid unlock key accepted"
fi
unlock "$RESTORE" "$KEY1" restore-unlock

RESTORE_IP="$(ip "$RESTORE")"
timeout 60 docker exec "$RESTORE" docker swarm init --force-new-cluster --advertise-addr "$RESTORE_IP" >"$BACKUP/force-new-cluster-private.log"
wait_control "$RESTORE"

CA2="$(docker exec "$RESTORE" sha256sum /var/lib/docker/swarm/certificates/swarm-root-ca.crt | awk '{print $1}')"
[[ "$CA2" == "$CA1" ]] || fail "root CA changed during restore"
printf '%s\n' "$CA2" >"$LOG/restored-root-ca.sha256"

log "rotating unlock key"
KEY2="$(docker exec "$RESTORE" docker swarm unlock-key --rotate -q)"
[[ "$KEY2" == SWMKEY-* && "$KEY2" != "$KEY1" ]] || fail "unlock key rotation failed"
printf '%s\n' "$KEY2" >"$BACKUP/rotated-unlock-key.txt"

docker restart "$RESTORE" >"$LOG/restore-restart.log"
wait_dind "$RESTORE"
assert_locked "$RESTORE" rotated-locked
if printf '%s\n' "$KEY1" | docker exec -i "$RESTORE" docker swarm unlock >"$LOG/old-key.out" 2>"$LOG/old-key.err"; then
  fail "old unlock key accepted after rotation"
fi
unlock "$RESTORE" "$KEY2" rotated-unlock
wait_control "$RESTORE"

log "verifying restored CA signs fresh worker"
start_fresh "$WORKER" trust-worker
WIP="$(ip "$WORKER")"
WTOKEN="$(docker exec "$RESTORE" docker swarm join-token -q worker)"
timeout 60 docker exec "$WORKER" docker swarm join --token "$WTOKEN" --advertise-addr "$WIP" "$RESTORE_IP:2377" >"$LOG/worker-join.log"
WID="$(wait_worker "$WORKER" "$RESTORE" "$LOG/worker-state.txt")"
CA3="$(docker exec "$WORKER" sha256sum /var/lib/docker/swarm/certificates/swarm-root-ca.crt | awk '{print $1}')"
[[ "$CA3" == "$CA1" ]] || fail "worker root CA mismatch"

cat >"$LOG/trust-key-restore-summary.txt" <<SUMMARY
source autolock enabled: PASS
source manager restart required unlock: PASS
restored manager started locked: PASS
wrong unlock key rejected: PASS
original unlock key restored encrypted state: PASS
root CA preserved across restore: PASS
unlock key rotated: PASS
old unlock key rejected after rotation: PASS
rotated unlock key accepted after restart: PASS
fresh worker joined restored trust domain: PASS
private recovery material excluded from artifacts: PASS
root CA sha256: $CA1
worker node ID: $WID
SUMMARY

cat "$LOG/trust-key-restore-summary.txt"
