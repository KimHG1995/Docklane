#!/usr/bin/env bash
set -u

LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership-db-restore"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-}"
failed=0

remove_owned_container(){
  local name="$1"
  local file="$OWN/$name.container-id" id current
  [[ -f "$file" ]] || return 0
  id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$id" ]] || { rm -f "$file"; return 0; }

  if current="$(docker inspect --format '{{.Id}}' "$id" 2>/dev/null)"; then
    if [[ "$current" != "$id" ]]; then
      printf 'Refusing to remove unowned container for %s\n' "$name" >&2
      failed=1
      return 1
    fi
    if docker rm -f "$id" >/dev/null 2>&1; then
      rm -f "$file"
    else
      failed=1
      return 1
    fi
  else
    rm -f "$file"
  fi
}

if command -v docker >/dev/null 2>&1; then
  remove_owned_container docklane-or-db-restore || true
  remove_owned_container docklane-or-db-source || true
fi

if [[ -n "$BACKUP" ]]; then
  case "$(basename "$BACKUP")" in
    docklane-db-backup-private-*) rm -rf -- "$BACKUP" ;;
    *) printf 'Refusing unsafe DB backup cleanup path: %s\n' "$BACKUP" >&2; failed=1 ;;
  esac
fi

if [[ -d "$OWN" ]] && [[ -z "$(find "$OWN" -type f -print -quit 2>/dev/null)" ]]; then
  rmdir "$OWN" 2>/dev/null || true
fi

(( failed == 0 )) || exit 1
printf 'Docklane DB restore cleanup complete\n'
