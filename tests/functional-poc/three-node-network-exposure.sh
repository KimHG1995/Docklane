#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${DOCKLANE_POC_LOG_DIR:?DOCKLANE_POC_LOG_DIR is required}"
MANAGER_CONTAINER="docklane-poc-manager-01"
WORKER_01_CONTAINER="docklane-poc-worker-01"
WORKER_02_CONTAINER="docklane-poc-worker-02"

fail() {
  printf '[functional-poc-3node-network] ERROR: %s\n' "$*" >&2
  exit 1
}

for node in "$MANAGER_CONTAINER" "$WORKER_01_CONTAINER" "$WORKER_02_CONTAINER"; do
  output="$LOG_DIR/network-exposure-${node}.json"
  docker inspect "$node" >"$output"

  jq -e '
    (.[] | .HostConfig.PortBindings // {}) as $bindings
    | [
        "2377/tcp",
        "7946/tcp",
        "7946/udp",
        "4789/udp"
      ]
    | all(. as $port | ($bindings[$port] == null))
  ' "$output" >/dev/null     || fail "$node publishes a Swarm-internal port to the outer Docker host"
done

jq -e '
  .[0].HostConfig.PortBindings["2375/tcp"] as $binding
  | ($binding | type == "array")
  and ($binding | length > 0)
  and ($binding | all(.HostIp == "127.0.0.1"))
' "$LOG_DIR/network-exposure-${MANAGER_CONTAINER}.json" >/dev/null   || fail "manager Docker API is not bound exclusively to 127.0.0.1"

for worker in "$WORKER_01_CONTAINER" "$WORKER_02_CONTAINER"; do
  jq -e '
    (.[0].HostConfig.PortBindings // {})["2375/tcp"] == null
    and (.[0].HostConfig.PortBindings // {})["2376/tcp"] == null
  ' "$LOG_DIR/network-exposure-${worker}.json" >/dev/null     || fail "$worker publishes a Docker API port to the outer host"
done

docker network inspect docklane-poc-3node-net >"$LOG_DIR/network-exposure-outer-network.json"
jq -e '.[0].Driver == "bridge" and .[0].Scope == "local"'   "$LOG_DIR/network-exposure-outer-network.json" >/dev/null   || fail "three-node outer network is not a local bridge network"

cat >"$LOG_DIR/network-exposure-summary.txt" <<EOF
Swarm 2377/tcp outer-host publication: BLOCKED
Swarm 7946/tcp+udp outer-host publication: BLOCKED
Swarm 4789/udp outer-host publication: BLOCKED
manager Docker API loopback-only binding: PASS
worker Docker API outer-host publication: BLOCKED
outer topology network local bridge: PASS
EOF

cat "$LOG_DIR/network-exposure-summary.txt"
