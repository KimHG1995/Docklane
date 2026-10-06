#!/usr/bin/env bash
set -u
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-}"
failed=0

# Return 0 only for the recorded ID, 2 only for confirmed absence, and 1
# for uncertain failures. Never interpret a generic "not found" as absence.
inspect_owned_resource(){
  local kind="$1" id="$2" output status
  if [[ "$kind" == container ]]; then
    output="$(docker inspect --type container --format '{{.Id}}' "$id" 2>&1)"
    status=$?
  else
    output="$(docker network inspect --format '{{.Id}}' "$id" 2>&1)"
    status=$?
  fi
  if (( status == 0 )); then
    [[ "$output" == "$id" ]]
    return $?
  fi
  (( status == 1 )) || return 1
  if [[ "$kind" == container ]]; then
    case "$output" in
      "Error: No such container: $id"|"Error response from daemon: No such container: $id"|"Error: No such object: $id") return 2 ;;
    esac
  else
    case "$output" in
      "Error response from daemon: network $id not found"|"Error: No such network: $id"|"Error: No such object: $id") return 2 ;;
    esac
  fi
  return 1
}

remove_container(){
  local name="$1"
  local file="$OWN/$name.container-id" id status
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }
  if inspect_owned_resource container "$id"; then
    docker rm -fv "$id" >/dev/null 2>&1 && rm -f "$file" && return 0
  else
    status=$?
    if (( status == 2 )); then
      rm -f "$file" && return 0
    fi
  fi
  failed=1
  return 1
}

remove_network(){
  local file="$OWN/manager-network.network-id" id status
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }
  if inspect_owned_resource network "$id"; then
    docker network rm "$id" >/dev/null 2>&1 && rm -f "$file" && return 0
  else
    status=$?
    if (( status == 2 )); then
      rm -f "$file" && return 0
    fi
  fi
  failed=1
  return 1
}

if command -v docker >/dev/null 2>&1; then
  remove_container manager-03
  remove_container manager-02
  remove_container manager-01
  remove_network
fi

if [[ -n "$BACKUP" ]]; then
  case "$(basename "$BACKUP")" in
    docklane-swarm-backup-private-*) rm -rf -- "$BACKUP" ;;
    *) printf 'Refusing unsafe backup cleanup path: %s\n' "$BACKUP" >&2; failed=1 ;;
  esac
fi

(( failed == 0 )) || exit 1
printf 'Swarm backup/restore cleanup complete\n'
