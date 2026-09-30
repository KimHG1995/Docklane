#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOPOLOGY="$ROOT_DIR/tests/functional-poc/three-node-topology.sh"
LB="$ROOT_DIR/tests/functional-poc/three-node-external-lb.sh"

grep -F 'export DOCKLANE_POC_LOG_DIR="$LOG_DIR"' "$TOPOLOGY" >/dev/null   || { echo "three-node topology must export resolved PoC log directory" >&2; exit 1; }

grep -F 'trap stop_traffic EXIT' "$LB" >/dev/null   || { echo "external LB harness must cleanup traffic generator on EXIT" >&2; exit 1; }

grep -F 'touch "$stop_file"' "$LB" >/dev/null   || { echo "external LB cleanup must create stop file" >&2; exit 1; }

grep -F 'wait "$traffic_pid"' "$LB" >/dev/null   || { echo "external LB cleanup must wait for traffic generator" >&2; exit 1; }

grep -F 'stop_traffic' "$LB" >/dev/null   || { echo "external LB success path must reuse traffic cleanup" >&2; exit 1; }

echo "three-node harness cleanup regressions: PASS"
