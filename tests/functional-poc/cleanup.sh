#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
cleanup_failed=0

mark_failed() {
  cleanup_failed=1
}

kill_owned_pid() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.pid"

  [[ -f "$file" ]] || return 0

  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$file"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$file"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  sleep 0.1
  if kill -0 "$pid" 2>/dev/null; then
    mark_failed
    return 1
  fi

  rm -f "$file"
}

remove_owned_container() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.container-id"

  [[ -f "$file" ]] || return 0

  local owned_id current_id
  owned_id="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$owned_id" ]]; then
    rm -f "$file"
    return 0
  fi

  current_id="$(docker inspect --format '{{.Id}}' "$owned_id" 2>/dev/null || true)"
  if [[ -z "$current_id" ]]; then
    rm -f "$file"
    return 0
  fi

  if [[ "$current_id" != "$owned_id" ]]; then
    mark_failed
    return 1
  fi

  if ! docker rm -f "$owned_id" >/dev/null 2>&1; then
    mark_failed
    return 1
  fi

  current_id="$(docker inspect --format '{{.Id}}' "$owned_id" 2>/dev/null || true)"
  if [[ -n "$current_id" ]]; then
    mark_failed
    return 1
  fi

  rm -f "$file"
}

remove_owned_service() {
  local file="$OWNERSHIP_DIR/service.id"
  [[ -f "$file" ]] || return 0

  local owned_id current_id
  owned_id="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$owned_id" ]]; then
    rm -f "$file"
    return 0
  fi

  current_id="$(docker service inspect "$owned_id" --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -z "$current_id" ]]; then
    rm -f "$file"
    return 0
  fi

  if [[ "$current_id" != "$owned_id" ]]; then
    mark_failed
    return 1
  fi

  if ! docker service rm "$owned_id" >/dev/null 2>&1; then
    mark_failed
    return 1
  fi

  current_id="$(docker service inspect "$owned_id" --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$current_id" ]]; then
    mark_failed
    return 1
  fi

  rm -f "$file"
}

leave_owned_swarm() {
  local file="$OWNERSHIP_DIR/swarm.node-id"
  [[ -f "$file" ]] || return 0

  local owned_node current_node state
  owned_node="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$owned_node" ]]; then
    rm -f "$file"
    return 0
  fi

  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  if [[ "$state" != "active" ]]; then
    rm -f "$file"
    return 0
  fi

  current_node="$(docker info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
  if [[ "$current_node" != "$owned_node" ]]; then
    mark_failed
    return 1
  fi

  if ! docker swarm leave --force >/dev/null 2>&1; then
    mark_failed
    return 1
  fi

  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then
    mark_failed
    return 1
  fi

  rm -f "$file"
}

kill_owned_pid api || true
kill_owned_pid agent-proxy || true
kill_owned_pid agent || true

if command -v docker >/dev/null 2>&1; then
  remove_owned_service || true
  leave_owned_swarm || true
  remove_owned_container registry || true
  remove_owned_container mysql || true
fi

rm -f "$LOG_DIR/drop-agent-image-response"

if [[ -d "$OWNERSHIP_DIR" ]] && [[ -z "$(find "$OWNERSHIP_DIR" -type f -print -quit 2>/dev/null)" ]]; then
  rmdir "$OWNERSHIP_DIR" 2>/dev/null || true
fi

if (( cleanup_failed != 0 )); then
  printf 'Functional PoC cleanup incomplete; ownership markers preserved for retry (%s)\n' "$ROOT_DIR" >&2
  exit 1
fi

printf 'Functional PoC cleanup complete (%s)\n' "$ROOT_DIR"
