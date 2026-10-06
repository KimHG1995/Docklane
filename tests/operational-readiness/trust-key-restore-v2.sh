#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

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
IMG="${DOCKLANE_OR_DIND_IMAGE:-docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac}"

export DOCKLANE_OR_LOG_DIR="$LOG"
export DOCKLANE_OR_PRIVATE_BACKUP_DIR="$BACKUP"

log(){ printf '[operational-readiness] %s\n' "$*"; }
fail(){ printf '[operational-readiness] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup(){ bash "$ROOT/tests/operational-readiness/trust-key-restore-cleanup.sh" || true; }
record(){ printf '%s\n' "$2" >"$OWN/$1.container-id"; }

# Bound both the CLI in DinD and the outer Docker exec. Killing only the outer
# CLI leaves the inner command running. A timed-out mutation has an uncertain
# daemon-side outcome: fail this drill; never retry it or continue recovery.
swarm_call(){
  local container="$1"
  local limit="${DOCKLANE_OR_RECOVERY_CALL_TIMEOUT_SECONDS:-30}"
  shift
  [[ "$limit" =~ ^[1-9][0-9]?$ && "$limit" -le 60 ]] \
    || fail "recovery call timeout must be an integer between 1 and 60 seconds"
  timeout --kill-after=2 "$((limit + 2))" \
    docker exec -i "$container" timeout -s KILL "$limit" docker "$@"
}

# Change a significant base64 digit, not ignored trailing padding bits.
different_unlock_key(){
  local payload="${1#SWMKEY-1-}" first=A
  [[ "$1" == SWMKEY-1-* && "$payload" =~ ^[A-Za-z0-9+/]{43}$ ]] \
    || fail "unexpected unlock key encoding"
  [[ "${payload:0:1}" != A ]] || first=B
  printf 'SWMKEY-1-%s%s\n' "$first" "${payload:1}"
}

wait_dind(){
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    swarm_call "$1" version >/dev/null 2>&1 && return 0
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
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if swarm_call "$1" node ls --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' >"$out" 2>/dev/null; then
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
  local container="$1" phase="$2" state status
  log "checking locked state: $phase"
  if ! state="$(swarm_call "$container" info --format '{{.Swarm.LocalNodeState}}' 2>"$LOG/$phase-state.err")"; then
    fail "$phase: cannot establish local Swarm state"
  fi
  printf '%s\n' "$state" >"$LOG/$phase-state.txt"
  [[ "$state" == locked ]] || fail "$phase: local Swarm state is not locked"
  if swarm_call "$container" node ls >"$LOG/$phase.out" 2>"$LOG/$phase.err"; then
    fail "$phase: locked manager unexpectedly accepted Swarm reads"
  else
    status=$?
  fi
  [[ "$status" == 1 ]] &&
    grep -Fqi 'Swarm is encrypted and needs to be unlocked' "$LOG/$phase.err" \
    || fail "$phase: read failed without a confirmed locked-manager rejection (exit $status)"
}

unlock(){
  local container="$1" key="$2" phase="$3" status
  log "starting unlock: $phase"
  printf 'phase=%s\nstatus=started\n' "$phase" >"$LOG/$phase-status.txt"
  if printf '%s\n' "$key" | swarm_call "$container" swarm unlock >"$LOG/$phase.out" 2>"$LOG/$phase.err"; then
    printf 'phase=%s\nstatus=completed\n' "$phase" >"$LOG/$phase-status.txt"
    log "completed unlock: $phase"
  else
    status=$?
    printf 'phase=%s\nstatus=failed\nexit=%s\n' "$phase" "$status" >"$LOG/$phase-status.txt"
    # Preserve failure and collect evidence BEFORE EXIT cleanup removes DinD.
    # No key is passed to the collector; partial diagnostics never permit retry.
    if ! timeout --kill-after=2 40 python3 "$ROOT/tests/operational-readiness/recovery-diagnostics.py" "$container" "$phase" "$status"; then
      log "diagnostics incomplete: $phase (original failure retained)" >&2
    fi
    fail "$phase: unlock failed or timed out (exit $status); no retry or force-new-cluster continuation"
  fi
}

reject_unlock(){
  local container="$1" key="$2" phase="$3" status
  log "checking invalid-key rejection: $phase"
  if printf '%s\n' "$key" | swarm_call "$container" swarm unlock >"$LOG/$phase.out" 2>"$LOG/$phase.err"; then
    fail "$phase: invalid unlock key was accepted"
  else
    status=$?
  fi
  [[ "$status" == 1 ]] && grep -Fqi 'swarm could not be unlocked: invalid key provided' "$LOG/$phase.err" \
    || fail "$phase: failure is not a confirmed invalid-key rejection (exit $status)"
  assert_locked "$container" "$phase-still-locked"
}

wait_control(){
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local available
    available="$(swarm_call "$1" info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)"
    [[ "$available" == true ]] && return 0
    sleep 1
  done
  fail "Swarm control not available: $1"
}

wait_worker(){
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    local id state role
    id="$(swarm_call "$1" info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
    if [[ -n "$id" ]] && swarm_call "$2" node inspect "$id" --format '{{.Status.State}}|{{.Spec.Role}}' >"$3" 2>/dev/null; then
      IFS='|' read -r state role <"$3"
      [[ "$state" == ready && "$role" == worker ]] && { printf '%s\n' "$id"; return 0; }
    fi
    sleep 1
  done
  fail "worker did not become Ready"
}

# Rebuild only on a stopped copy, before sending any correct-key restore unlock.
# A failure never restarts Docker or retries the partially rebuilt copy.
offline_restore_quorum(){
  local rid="$1" key="$2" ca="$3"
  log "rebuilding single-backup quorum on stopped isolated copy"
  docker stop "$rid" >"$LOG/offline-restore-stop.log"
  if ! printf '%s\n' "$key" | timeout --kill-after=3 55 \
      python3 "$ROOT/tests/operational-readiness/offline-quorum-rebuild.py" "$rid" "$ca"; then
    fail "offline quorum rebuild failed; no restart or unlock continuation"
  fi
  docker start "$rid" >"$LOG/offline-restore-start.log"
  wait_dind "$RESTORE"
  assert_locked "$RESTORE" rebuilt-still-locked
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
[[ "$(swarm_call "$M1" version --format '{{.Server.Version}}')" == 28.5.2 ]] || fail "pinned recovery helper requires Engine 28.5.2"

IP1="$(ip "$M1")"; IP2="$(ip "$M2")"; IP3="$(ip "$M3")"
swarm_call "$M1" swarm init --autolock --advertise-addr "$IP1" >"$BACKUP/swarm-init-private.log"
KEY1="$(swarm_call "$M1" swarm unlock-key -q)"
[[ "$KEY1" == SWMKEY-* ]] || fail "unlock key missing"
printf '%s\n' "$KEY1" >"$BACKUP/unlock-key.txt"

TOKEN="$(swarm_call "$M1" swarm join-token -q manager)"
swarm_call "$M2" swarm join --token "$TOKEN" --advertise-addr "$IP2" "$IP1:2377" >"$LOG/manager-02-join.log"
swarm_call "$M3" swarm join --token "$TOKEN" --advertise-addr "$IP3" "$IP1:2377" >"$LOG/manager-03-join.log"
wait_three "$M1" "$LOG/topology-before-backup.txt"
SOURCE_CLUSTER_ID="$(swarm_call "$M1" info --format '{{.Swarm.Cluster.ID}}')"
[[ -n "$SOURCE_CLUSTER_ID" ]] || fail "source cluster ID missing"
printf '%s\n' "$SOURCE_CLUSTER_ID" >"$LOG/source-cluster-id.txt"

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

cat "$OWN/$M1.container-id" "$OWN/$M2.container-id" "$OWN/$M3.container-id" >"$LOG/original-managers.ids"
docker rm -fv "$M3" "$M2" "$M1" >"$LOG/source-managers-remove.log"
rm -f "$OWN/$M1.container-id" "$OWN/$M2.container-id" "$OWN/$M3.container-id"

log "restoring encrypted state"
RID="$(docker create --privileged --name "$RESTORE" --hostname "$BACKUP_HOST" --network "$NET" --ip "$BACKUP_IP" -e DOCKER_TLS_CERTDIR= "$IMG")"
record "$RESTORE" "$RID"
docker run --rm --volumes-from "$RESTORE" -v "$BACKUP:/backup:ro" --entrypoint sh "$IMG" -c 'rm -rf /var/lib/docker/swarm && tar -C /var/lib/docker -xf /backup/swarm.tar'
docker start "$RESTORE" >"$LOG/restore-start.log"
wait_dind "$RESTORE"
assert_locked "$RESTORE" restore-locked

BAD_KEY="$(different_unlock_key "$KEY1")"
reject_unlock "$RESTORE" "$BAD_KEY" wrong-key

offline_restore_quorum "$RID" "$KEY1" "$CA1"
unlock "$RESTORE" "$KEY1" restore-unlock

RESTORE_IP="$(ip "$RESTORE")"
log "verifying rebuilt quorum with the normal Docker API"
wait_control "$RESTORE"
[[ "$(swarm_call "$RESTORE" info --format '{{.Swarm.Cluster.ID}}')" == "$SOURCE_CLUSTER_ID" ]] || fail "restored cluster ID mismatch"
SELF="$(swarm_call "$RESTORE" info --format '{{.Swarm.NodeID}}')"
[[ "$(swarm_call "$RESTORE" node inspect "$SELF" --format '{{.ManagerStatus.Leader}}')" == true ]] || fail "restored manager is not elected leader"
printf '%s\n' "$SOURCE_CLUSTER_ID" >"$LOG/restored-cluster-id.txt"

CA2="$(docker exec "$RESTORE" sha256sum /var/lib/docker/swarm/certificates/swarm-root-ca.crt | awk '{print $1}')"
[[ "$CA2" == "$CA1" ]] || fail "root CA changed during restore"
printf '%s\n' "$CA2" >"$LOG/restored-root-ca.sha256"

log "rotating unlock key"
KEY2="$(swarm_call "$RESTORE" swarm unlock-key --rotate -q)"
[[ "$KEY2" == SWMKEY-* && "$KEY2" != "$KEY1" ]] || fail "unlock key rotation failed"
printf '%s\n' "$KEY2" >"$BACKUP/rotated-unlock-key.txt"

docker restart "$RESTORE" >"$LOG/restore-restart.log"
wait_dind "$RESTORE"
assert_locked "$RESTORE" rotated-locked
reject_unlock "$RESTORE" "$KEY1" old-key
unlock "$RESTORE" "$KEY2" rotated-unlock
wait_control "$RESTORE"

log "verifying restored CA signs fresh worker"
start_fresh "$WORKER" trust-worker
WIP="$(ip "$WORKER")"
WTOKEN="$(swarm_call "$RESTORE" swarm join-token -q worker)"
swarm_call "$WORKER" swarm join --token "$WTOKEN" --advertise-addr "$WIP" "$RESTORE_IP:2377" >"$LOG/worker-join.log"
WID="$(wait_worker "$WORKER" "$RESTORE" "$LOG/worker-state.txt")"
CA3="$(docker exec "$WORKER" sha256sum /var/lib/docker/swarm/certificates/swarm-root-ca.crt | awk '{print $1}')"
[[ "$CA3" == "$CA1" ]] || fail "worker root CA mismatch"

cat >"$LOG/trust-key-restore-summary.txt" <<SUMMARY
source autolock enabled: PASS
source manager restart required unlock: PASS
restored manager started locked: PASS
wrong unlock key rejected: PASS
all original manager IDs confirmed absent: PASS
offline quorum rebuild on stopped copy: PASS
rebuilt manager still required original unlock key: PASS
original unlock key restored encrypted state: PASS
original cluster ID preserved: PASS
restored manager elected leader: PASS
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
