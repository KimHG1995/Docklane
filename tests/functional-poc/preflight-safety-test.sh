#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! grep -Eq 'docker service create[[:space:]].*--quiet' "$ROOT_DIR/tests/functional-poc/run.sh"; then
  echo "docker service create must use --quiet so SERVICE_ID contains only the ID" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
DOCKER_LOG="$TMP_DIR/docker.log"
POC_LOG="$TMP_DIR/poc"
mkdir -p "$FAKE_BIN" "$POC_LOG/ownership"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$DOCKER_FAKE_LOG"
if [[ "${1:-}" == "info" ]]; then
  printf 'active\n'
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/docker"

for command in curl jq pnpm go; do
  cat >"$FAKE_BIN/$command" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$FAKE_BIN/$command"
done

# Stale ownership state must not trigger cleanup when preflight rejects the host.
printf 'stale-node\n' >"$POC_LOG/ownership/swarm.node-id"
printf 'stale-service\n' >"$POC_LOG/ownership/service.id"
printf 'stale-container\n' >"$POC_LOG/ownership/mysql.container-id"

set +e
PATH="$FAKE_BIN:$PATH" DOCKER_FAKE_LOG="$DOCKER_LOG" DOCKLANE_POC_LOG_DIR="$POC_LOG" bash "$ROOT_DIR/tests/functional-poc/run.sh"   >"$TMP_DIR/stdout.log" 2>"$TMP_DIR/stderr.log"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "expected active Swarm preflight to reject the run" >&2
  exit 1
fi

if grep -Eq 'service rm|swarm leave|(^| )rm( |$)' "$DOCKER_LOG"; then
  echo "preflight rejection invoked a destructive Docker cleanup command" >&2
  cat "$DOCKER_LOG" >&2
  exit 1
fi

if [[ ! -f "$POC_LOG/ownership/swarm.node-id" ]]; then
  echo "preflight rejection removed pre-existing ownership state" >&2
  exit 1
fi

echo "preflight safety regression: PASS"
