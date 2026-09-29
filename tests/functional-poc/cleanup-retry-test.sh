#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/bin"
STATE_DIR="$TMP_DIR/state"
POC_LOG="$TMP_DIR/poc"
DOCKER_LOG="$TMP_DIR/docker.log"

mkdir -p "$FAKE_BIN" "$STATE_DIR" "$POC_LOG/ownership"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -eu

printf '%s\n' "$*" >>"$DOCKER_FAKE_LOG"

is_removed() {
  [[ -f "$DOCKER_FAKE_STATE/removed-$1" ]]
}

case "${1:-}" in
  inspect)
    id="${@: -1}"
    if is_removed "$id"; then
      exit 1
    fi
    printf '%s\n' "$id"
    ;;
  rm)
    id="${@: -1}"
    if [[ -f "$DOCKER_FAKE_STATE/fail" ]]; then
      exit 1
    fi
    touch "$DOCKER_FAKE_STATE/removed-$id"
    ;;
  service)
    case "${2:-}" in
      inspect)
        id="${3:-}"
        if is_removed "service-$id"; then
          exit 1
        fi
        printf '%s\n' "$id"
        ;;
      rm)
        id="${3:-}"
        if [[ -f "$DOCKER_FAKE_STATE/fail" ]]; then
          exit 1
        fi
        touch "$DOCKER_FAKE_STATE/removed-service-$id"
        ;;
    esac
    ;;
  info)
    if [[ "$*" == *"LocalNodeState"* ]]; then
      if [[ -f "$DOCKER_FAKE_STATE/swarm-left" ]]; then
        printf 'inactive\n'
      else
        printf 'active\n'
      fi
    elif [[ "$*" == *"NodeID"* ]]; then
      printf 'node-owned\n'
    fi
    ;;
  swarm)
    if [[ "${2:-}" == "leave" ]]; then
      if [[ -f "$DOCKER_FAKE_STATE/fail" ]]; then
        exit 1
      fi
      touch "$DOCKER_FAKE_STATE/swarm-left"
    fi
    ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"

printf 'service-owned\n' >"$POC_LOG/ownership/service.id"
printf 'node-owned\n' >"$POC_LOG/ownership/swarm.node-id"
printf 'registry-owned\n' >"$POC_LOG/ownership/registry.container-id"
printf 'mysql-owned\n' >"$POC_LOG/ownership/mysql.container-id"

touch "$STATE_DIR/fail"

set +e
PATH="$FAKE_BIN:$PATH" DOCKER_FAKE_LOG="$DOCKER_LOG" DOCKER_FAKE_STATE="$STATE_DIR" DOCKLANE_POC_LOG_DIR="$POC_LOG" bash "$ROOT_DIR/tests/functional-poc/cleanup.sh"
first_status=$?
set -e

if [[ "$first_status" -eq 0 ]]; then
  echo "expected first cleanup to report failure" >&2
  exit 1
fi

for marker in   service.id   swarm.node-id   registry.container-id   mysql.container-id; do
  if [[ ! -f "$POC_LOG/ownership/$marker" ]]; then
    echo "failed cleanup removed ownership marker: $marker" >&2
    exit 1
  fi
done

rm -f "$STATE_DIR/fail"

PATH="$FAKE_BIN:$PATH" DOCKER_FAKE_LOG="$DOCKER_LOG" DOCKER_FAKE_STATE="$STATE_DIR" DOCKLANE_POC_LOG_DIR="$POC_LOG" bash "$ROOT_DIR/tests/functional-poc/cleanup.sh"

if [[ -d "$POC_LOG/ownership" ]]; then
  echo "successful retry did not clear ownership directory" >&2
  find "$POC_LOG/ownership" -maxdepth 1 -type f -print >&2 || true
  exit 1
fi

if [[ "$(grep -c '^service rm service-owned$' "$DOCKER_LOG" || true)" != "2" ]]; then
  echo "service cleanup was not retried" >&2
  cat "$DOCKER_LOG" >&2
  exit 1
fi

if [[ "$(grep -c '^swarm leave --force$' "$DOCKER_LOG" || true)" != "2" ]]; then
  echo "Swarm cleanup was not retried" >&2
  cat "$DOCKER_LOG" >&2
  exit 1
fi

if [[ "$(grep -c '^rm -f registry-owned$' "$DOCKER_LOG" || true)" != "2" ]] ||
   [[ "$(grep -c '^rm -f mysql-owned$' "$DOCKER_LOG" || true)" != "2" ]]; then
  echo "container cleanup was not retried" >&2
  cat "$DOCKER_LOG" >&2
  exit 1
fi

echo "cleanup retry regression: PASS"
