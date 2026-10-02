#!/usr/bin/env bash
set -u
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-}"
failed=0

remove_container(){
  local key="$1"
  local file="$OWN/$key.container-id"
  local id current
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }
  if current="$(docker inspect --format '{{.Id}}' "$id" 2>/dev/null)"; then
    [[ "$current" == "$id" ]] || { failed=1; return 1; }
    docker rm -fv "$id" >/dev/null 2>&1 && rm -f "$file" || failed=1
  else
    rm -f "$file"
  fi
}

remove_network(){
  local file="$OWN/manager-network.network-id" id current
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  if current="$(docker network inspect --format '{{.Id}}' "$id" 2>/dev/null)"; then
    [[ "$current" == "$id" ]] || { failed=1; return 1; }
    docker network rm "$id" >/dev/null 2>&1 && rm -f "$file" || failed=1
  else
    rm -f "$file"
  fi
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
