#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc}"
OWNERSHIP_DIR="$LOG_DIR/ownership"

kill_owned_pid() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.pid"

  if [[ ! -f "$file" ]]; then
    return
  fi

  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
}

remove_owned_container() {
  local name="$1"
  local file="$OWNERSHIP_DIR/$name.container-id"

  [[ -f "$file" ]] || return

  local owned_id current_id
  owned_id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$owned_id" ]] || return

  current_id="$(docker inspect --format '{{.Id}}' "$owned_id" 2>/dev/null || true)"
  if [[ "$current_id" == "$owned_id" ]]; then
    docker rm -f "$owned_id" >/dev/null 2>&1 || true
  fi
}

remove_owned_service() {
  local file="$OWNERSHIP_DIR/service.id"
  [[ -f "$file" ]] || return

  local owned_id current_id
  owned_id="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$owned_id" ]] || return

  current_id="$(docker service inspect "$owned_id" --format '{{.ID}}' 2>/dev/null || true)"
  if [[ "$current_id" == "$owned_id" ]]; then
    docker service rm "$owned_id" >/dev/null 2>&1 || true
  fi
}

leave_owned_swarm() {
  local file="$OWNERSHIP_DIR/swarm.node-id"
  [[ -f "$file" ]] || return

  local owned_node current_node state
  owned_node="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$owned_node" ]] || return

  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ "$state" == "active" ]] || return

  current_node="$(docker info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
  if [[ "$current_node" == "$owned_node" ]]; then
    docker swarm leave --force >/dev/null 2>&1 || true
  fi
}

kill_owned_pid api
kill_owned_pid agent-proxy
kill_owned_pid agent

if command -v docker >/dev/null 2>&1; then
  remove_owned_service
  leave_owned_swarm
  remove_owned_container registry
  remove_owned_container mysql
fi

rm -f "$LOG_DIR/drop-agent-image-response"
rm -rf "$OWNERSHIP_DIR"

printf 'Functional PoC cleanup complete (%s)\n' "$ROOT_DIR"
