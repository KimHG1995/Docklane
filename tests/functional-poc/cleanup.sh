#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_POC_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-poc}"

kill_from_pidfile() {
  local name="$1"
  local file="$LOG_DIR/$name.pid"

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

kill_from_pidfile api
kill_from_pidfile agent

if command -v docker >/dev/null 2>&1; then
  if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" == "active" ]]; then
    docker service rm docklane-poc >/dev/null 2>&1 || true
  fi

  if [[ -f "$LOG_DIR/swarm-created" ]]; then
    docker swarm leave --force >/dev/null 2>&1 || true
  fi

  docker rm -f docklane-poc-registry docklane-poc-mysql >/dev/null 2>&1 || true
fi

rm -f "$LOG_DIR/api.pid" "$LOG_DIR/agent.pid" "$LOG_DIR/swarm-created"

printf 'Functional PoC cleanup complete (%s)\n' "$ROOT_DIR"
