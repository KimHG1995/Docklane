#!/usr/bin/env bash
set -u

LOG_DIR="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
cleanup_failed=0

mark_failed() {
  cleanup_failed=1
}

is_not_found_error() {
  local file="$1"
  grep -Eqi 'no such (object|container)|not found' "$file"
}

remove_owned_container() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.container-id"

  [[ -f "$file" ]] || return 0

  local owned_id current_id error_file
  owned_id="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$owned_id" ]]; then
    rm -f "$file"
    return 0
  fi

  error_file="$OWNERSHIP_DIR/.$name.inspect.err"
  if current_id="$(docker inspect --format '{{.Id}}' "$owned_id" 2>"$error_file")"; then
    rm -f "$error_file"
  else
    if is_not_found_error "$error_file"; then
      rm -f "$error_file" "$file"
      return 0
    fi
    rm -f "$error_file"
    mark_failed
    return 1
  fi

  if [[ "$current_id" != "$owned_id" ]]; then
    mark_failed
    return 1
  fi

  if docker rm -f "$owned_id" >/dev/null 2>&1; then
    rm -f "$file"
    return 0
  fi

  mark_failed
  return 1
}

remove_owned_network() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.network-id"

  [[ -f "$file" ]] || return 0

  local owned_id current_id error_file
  owned_id="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$owned_id" ]]; then
    rm -f "$file"
    return 0
  fi

  error_file="$OWNERSHIP_DIR/.$name.inspect.err"
  if current_id="$(docker network inspect --format '{{.Id}}' "$owned_id" 2>"$error_file")"; then
    rm -f "$error_file"
  else
    if is_not_found_error "$error_file"; then
      rm -f "$error_file" "$file"
      return 0
    fi
    rm -f "$error_file"
    mark_failed
    return 1
  fi

  if [[ "$current_id" != "$owned_id" ]]; then
    mark_failed
    return 1
  fi

  if docker network rm "$owned_id" >/dev/null 2>&1; then
    rm -f "$file"
    return 0
  fi

  mark_failed
  return 1
}

if command -v docker >/dev/null 2>&1; then
  remove_owned_container manager-03 || true
  remove_owned_container manager-02 || true
  remove_owned_container manager-01 || true
  remove_owned_network manager-network || true
fi

if [[ -d "$OWNERSHIP_DIR" ]] && [[ -z "$(find "$OWNERSHIP_DIR" -type f -print -quit 2>/dev/null)" ]]; then
  rmdir "$OWNERSHIP_DIR" 2>/dev/null || true
fi

if (( cleanup_failed != 0 )); then
  printf 'Operational readiness cleanup incomplete; ownership markers preserved for retry\n' >&2
  exit 1
fi

printf 'Operational readiness cleanup complete\n'
