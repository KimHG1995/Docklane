#!/usr/bin/env bash
set -u
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership-trust-key"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-}"
failed=0

remove_container(){
  local name="$1"
  local file="$OWN/$name.container-id" id current
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }
  if current="$(docker inspect --format '{{.Id}}' "$id" 2>/dev/null)"; then
    [[ "$current" == "$id" ]] || { failed=1; return 1; }
    docker rm -f "$id" >/dev/null 2>&1 && rm -f "$file" || failed=1
  else
    rm -f "$file"
  fi
}

remove_network(){
  local file="$OWN/manager-network.network-id" id
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }
  docker network rm "$id" >/dev/null 2>&1 && rm -f "$file" || failed=1
}

if command -v docker >/dev/null 2>&1; then
  for name in docklane-or-trust-worker docklane-or-trust-restore docklane-or-manager-03 docklane-or-manager-02 docklane-or-manager-01; do
    remove_container "$name" || true
  done
  remove_network || true
fi

if [[ -n "$BACKUP" ]]; then
  case "$(basename "$BACKUP")" in
    docklane-trust-backup-private-*) rm -rf -- "$BACKUP" ;;
    *) failed=1 ;;
  esac
fi

(( failed == 0 )) || exit 1
printf 'trust-key restore cleanup complete\n'
