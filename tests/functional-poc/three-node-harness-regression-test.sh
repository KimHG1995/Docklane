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

grep -F 'SWARM_CLUSTER_ID="$(docker exec "$MANAGER_CONTAINER" docker info --format' "$TOPOLOGY" >/dev/null || { echo "expected actual manager Swarm ID" >&2; exit 1; }
grep -F 'DOCKLANE_EXPECTED_CLUSTER_ID="$SWARM_CLUSTER_ID"' "$TOPOLOGY" >/dev/null || { echo "missing expected identity pin" >&2; exit 1; }
grep -F 'CLUSTER_REGISTRATION_REQUIRED' "$TOPOLOGY" >/dev/null || { echo "missing 503 guard verification" >&2; exit 1; }
grep -F 'VIEWER registration expected 403' "$TOPOLOGY" >/dev/null || { echo "missing authorization check" >&2; exit 1; }
grep -F 'expected exactly one cluster registration audit' "$TOPOLOGY" >/dev/null || { echo "missing registration audit verification" >&2; exit 1; }
grep -F 'worker failure preserves registered manager cluster identity' "$TOPOLOGY" >/dev/null || { echo "missing worker fault binding verification" >&2; exit 1; }
awk '/scenario: enforce denies unregistered/{first=NR} /DRAIN_NODE_JSON=/{if (!second) second=NR} END{exit !(first>0 && second>first)}' "$TOPOLOGY" || { echo "registration must precede drain" >&2; exit 1; }

echo "three-node harness cleanup regressions: PASS"
