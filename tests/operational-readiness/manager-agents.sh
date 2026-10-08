#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWNERSHIP_DIR="$LOG_DIR/ownership"
NETWORK_NAME="docklane-or-manager-net"
MANAGER_01_CONTAINER="docklane-or-manager-01"
MANAGER_02_CONTAINER="docklane-or-manager-02"
MANAGER_03_CONTAINER="docklane-or-manager-03"
REGISTRATION_DB_CONTAINER="docklane-or-manager-db"
REGISTRATION_DB_PORT=33307
MANAGER_01_AGENT_PORT="19443"
MANAGER_02_AGENT_PORT="19444"
MANAGER_03_AGENT_PORT="19445"
DIND_IMAGE="${DOCKLANE_OR_DIND_IMAGE:-docker:28-dind}"
AGENT_BINARY="${DOCKLANE_MANAGER_AGENT_BINARY:-}"
CERT_DIR="$LOG_DIR/manager-agent-certs"
CA_CERT="$CERT_DIR/ca.crt"
CA_KEY="$CERT_DIR/ca.key"
CA_SERIAL="$CERT_DIR/ca.srl"
CLIENT_CERT="$CERT_DIR/client.crt"
CLIENT_KEY="$CERT_DIR/client.key"

export DOCKLANE_OR_LOG_DIR="$LOG_DIR"

log() {
  printf '[operational-readiness] %s\n' "$*"
}

fail() {
  printf '[operational-readiness] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  bash "$ROOT_DIR/tests/operational-readiness/cleanup.sh" || true
}

preflight_absent_container() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    fail "refusing to start because container already exists: $name"
  fi
}

preflight_absent_network() {
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    fail "refusing to start because network already exists: $NETWORK_NAME"
  fi
}

wait_dind() {
  local container="$1"
  for _ in {1..90}; do
    if docker exec "$container" docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Docker daemon did not become ready in $container"
}

capture_topology() {
  local observer="$1"
  local output="$2"
  docker exec "$observer" docker node ls \
    --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' \
    >"$output"
}

wait_three_managers_ready() {
  local observer="$1"
  local output="$2"

  for _ in {1..120}; do
    if capture_topology "$observer" "$output" 2>/dev/null; then
      local total ready_active leaders reachable
      total="$(wc -l <"$output" | tr -d ' ')"
      ready_active="$(grep -c '|Ready|Active|' "$output" || true)"
      leaders="$(grep -c '|Leader$' "$output" || true)"
      reachable="$(grep -c '|Reachable$' "$output" || true)"
      if [[ "$total" == "3" && "$ready_active" == "3" && "$leaders" == "1" && "$reachable" == "2" ]]; then
        return 0
      fi
    fi
    sleep 1
  done

  fail "three-manager Swarm did not converge"
}

setup_mtls() {
  rm -rf "$CERT_DIR"
  mkdir -p "$CERT_DIR"

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_KEY" >/dev/null 2>&1
  openssl req -x509 -new -sha256 -days 1 \
    -key "$CA_KEY" \
    -subj '/CN=Docklane Manager Agent Test CA' \
    -out "$CA_CERT" >/dev/null 2>&1
  printf '1000\n' >"$CA_SERIAL"

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CLIENT_KEY" >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "$CLIENT_KEY" \
    -subj '/CN=docklane-control-plane' \
    -out "$CERT_DIR/client.csr" >/dev/null 2>&1
  cat >"$CERT_DIR/client.ext" <<'EOF'
extendedKeyUsage=clientAuth
keyUsage=digitalSignature
EOF
  openssl x509 -req -sha256 -days 1 \
    -in "$CERT_DIR/client.csr" \
    -CA "$CA_CERT" \
    -CAkey "$CA_KEY" \
    -CAserial "$CA_SERIAL" \
    -extfile "$CERT_DIR/client.ext" \
    -out "$CLIENT_CERT" >/dev/null 2>&1
}

issue_server_cert() {
  local manager="$1"
  local ip="$2"
  local key="$CERT_DIR/$manager.key"
  local csr="$CERT_DIR/$manager.csr"
  local cert="$CERT_DIR/$manager.crt"
  local ext="$CERT_DIR/$manager.ext"

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key" >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "$key" \
    -subj "/CN=$manager" \
    -out "$csr" >/dev/null 2>&1
  cat >"$ext" <<EOF
subjectAltName=DNS:$manager,IP:$ip
extendedKeyUsage=serverAuth
keyUsage=digitalSignature
EOF
  openssl x509 -req -sha256 -days 1 \
    -in "$csr" \
    -CA "$CA_CERT" \
    -CAkey "$CA_KEY" \
    -CAserial "$CA_SERIAL" \
    -extfile "$ext" \
    -out "$cert" >/dev/null 2>&1
}

start_agent() {
  local container="$1"
  local manager="$2"

  docker exec "$container" mkdir -p /etc/docklane
  docker cp "$AGENT_BINARY" "$container:/usr/local/bin/docklane-agent"
  docker cp "$CA_CERT" "$container:/etc/docklane/agent-ca.crt"
  docker cp "$CERT_DIR/$manager.crt" "$container:/etc/docklane/agent.crt"
  docker cp "$CERT_DIR/$manager.key" "$container:/etc/docklane/agent.key"
  docker exec "$container" chmod 0755 /usr/local/bin/docklane-agent
  docker exec "$container" chmod 0600 /etc/docklane/agent.key
  docker exec "$container" test -s /etc/docklane/agent-ca.crt
  docker exec "$container" test -s /etc/docklane/agent.crt
  docker exec "$container" test -s /etc/docklane/agent.key
  docker exec "$container" sh -c '
    DOCKER_HOST=unix:///var/run/docker.sock \
    DOCKLANE_AGENT_ADDR=0.0.0.0:9443 \
    DOCKLANE_AGENT_TLS_CERT_FILE=/etc/docklane/agent.crt \
    DOCKLANE_AGENT_TLS_KEY_FILE=/etc/docklane/agent.key \
    DOCKLANE_AGENT_TLS_CA_FILE=/etc/docklane/agent-ca.crt \
    /usr/local/bin/docklane-agent >/var/log/docklane-agent.log 2>&1 &
  '
}

wait_identity() {
  local manager="$1"
  local container="$2"
  local port="$3"
  local output="$4"

  for _ in {1..60}; do
    if curl -fsS \
      --connect-timeout 1 \
      --max-time 3 \
      --cacert "$CA_CERT" \
      --cert "$CLIENT_CERT" \
      --key "$CLIENT_KEY" \
      "https://127.0.0.1:$port/v1/identity" \
      >"$output" 2>/dev/null; then
      if python3 - "$output" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

required = {"component", "clusterId", "nodeId", "hostname", "manager", "leader"}
if not required.issubset(payload):
    raise SystemExit(1)
if payload["component"] != "docklane-agent" or payload["manager"] is not True:
    raise SystemExit(1)
PY
      then
        return 0
      fi
    fi
    sleep 1
  done

  docker exec "$container" sh -c 'cat /var/log/docklane-agent.log 2>/dev/null || true' >&2 || true
  fail "Agent identity did not become ready for $manager"
}

json_field() {
  local file="$1"
  local field="$2"
  python3 - "$file" "$field" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)[sys.argv[2]]
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

[[ -n "$AGENT_BINARY" && -x "$AGENT_BINARY" ]] \
  || fail "DOCKLANE_MANAGER_AGENT_BINARY must point to the built Go Agent"
[[ -f "$ROOT_DIR/apps/api/dist/agent/http-agent.client.js" ]] \
  || fail "built HttpAgentClient is required for failover acceptance"
for command in openssl curl node; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

preflight_absent_container "$MANAGER_01_CONTAINER"
preflight_absent_container "$MANAGER_02_CONTAINER"
preflight_absent_container "$MANAGER_03_CONTAINER"
preflight_absent_container "$REGISTRATION_DB_CONTAINER"
preflight_absent_network
[[ -f "$ROOT_DIR/apps/api/dist/clusters/cluster-binding.policy.js" ]] || fail "built cluster binding policy is missing"
node --check "$ROOT_DIR/tests/operational-readiness/manager-agents-registration.mjs" || fail "helper syntax error"

mkdir -p "$LOG_DIR"
rm -rf "$OWNERSHIP_DIR"
mkdir -p "$OWNERSHIP_DIR"
trap cleanup EXIT

log "creating isolated manager network"
NETWORK_ID="$(docker network create "$NETWORK_NAME")"
printf '%s\n' "$NETWORK_ID" >"$OWNERSHIP_DIR/manager-network.network-id"

log "starting three Docker-in-Docker managers"
MANAGER_01_ID="$(docker run -d --privileged --name "$MANAGER_01_CONTAINER" --hostname manager-01 --network "$NETWORK_NAME" -p "127.0.0.1:$MANAGER_01_AGENT_PORT:9443" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_01_ID" >"$OWNERSHIP_DIR/manager-01.container-id"
MANAGER_02_ID="$(docker run -d --privileged --name "$MANAGER_02_CONTAINER" --hostname manager-02 --network "$NETWORK_NAME" -p "127.0.0.1:$MANAGER_02_AGENT_PORT:9443" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_02_ID" >"$OWNERSHIP_DIR/manager-02.container-id"
MANAGER_03_ID="$(docker run -d --privileged --name "$MANAGER_03_CONTAINER" --hostname manager-03 --network "$NETWORK_NAME" -p "127.0.0.1:$MANAGER_03_AGENT_PORT:9443" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE")"
printf '%s\n' "$MANAGER_03_ID" >"$OWNERSHIP_DIR/manager-03.container-id"

wait_dind "$MANAGER_01_CONTAINER"
wait_dind "$MANAGER_02_CONTAINER"
wait_dind "$MANAGER_03_CONTAINER"

MANAGER_01_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_01_CONTAINER")"
MANAGER_02_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_02_CONTAINER")"
MANAGER_03_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$MANAGER_03_CONTAINER")"

[[ -n "$MANAGER_01_IP" && -n "$MANAGER_02_IP" && -n "$MANAGER_03_IP" ]] \
  || fail "failed to resolve manager network addresses"

log "creating manager Agent mTLS material"
setup_mtls
issue_server_cert manager-01 "127.0.0.1"
issue_server_cert manager-02 "127.0.0.1"
issue_server_cert manager-03 "127.0.0.1"

log "initializing three-manager Swarm"
docker exec "$MANAGER_01_CONTAINER" docker swarm init --advertise-addr "$MANAGER_01_IP" >"$LOG_DIR/swarm-init.log"
MANAGER_TOKEN="$(docker exec "$MANAGER_01_CONTAINER" docker swarm join-token -q manager)"
[[ -n "$MANAGER_TOKEN" ]] || fail "failed to read manager join token"

docker exec "$MANAGER_02_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_02_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-02-join.log"
docker exec "$MANAGER_03_CONTAINER" docker swarm join --token "$MANAGER_TOKEN" --advertise-addr "$MANAGER_03_IP" "$MANAGER_01_IP:2377" >"$LOG_DIR/manager-03-join.log"

wait_three_managers_ready "$MANAGER_01_CONTAINER" "$LOG_DIR/topology.txt"

log "deploying one mTLS Go Agent per manager"
start_agent "$MANAGER_01_CONTAINER" manager-01
start_agent "$MANAGER_02_CONTAINER" manager-02
start_agent "$MANAGER_03_CONTAINER" manager-03

wait_identity manager-01 "$MANAGER_01_CONTAINER" "$MANAGER_01_AGENT_PORT" "$LOG_DIR/manager-01-identity.json"
wait_identity manager-02 "$MANAGER_02_CONTAINER" "$MANAGER_02_AGENT_PORT" "$LOG_DIR/manager-02-identity.json"
wait_identity manager-03 "$MANAGER_03_CONTAINER" "$MANAGER_03_AGENT_PORT" "$LOG_DIR/manager-03-identity.json"

cluster_id=""
leader_count=0
node_ids=()

for manager in manager-01 manager-02 manager-03; do
  container_var="${manager//-/_}_container"
  case "$manager" in
    manager-01) container="$MANAGER_01_CONTAINER" ;;
    manager-02) container="$MANAGER_02_CONTAINER" ;;
    manager-03) container="$MANAGER_03_CONTAINER" ;;
  esac

  identity_file="$LOG_DIR/${manager}-identity.json"
  observed_node_id="$(json_field "$identity_file" nodeId)"
  observed_cluster_id="$(json_field "$identity_file" clusterId)"
  observed_hostname="$(json_field "$identity_file" hostname)"
  observed_leader="$(json_field "$identity_file" leader)"

  expected_node_id="$(docker exec "$container" docker info --format '{{.Swarm.NodeID}}')"
  expected_cluster_id="$(docker exec "$container" docker info --format '{{.Swarm.Cluster.ID}}')"

  [[ "$observed_node_id" == "$expected_node_id" ]] \
    || fail "$manager Agent reported node $observed_node_id, expected $expected_node_id"
  [[ "$observed_hostname" == "$manager" ]] \
    || fail "$manager Agent reported hostname $observed_hostname"
  [[ "$observed_cluster_id" == "$expected_cluster_id" ]] \
    || fail "$manager Agent reported cluster $observed_cluster_id, expected $expected_cluster_id"

  if [[ -z "$cluster_id" ]]; then
    cluster_id="$observed_cluster_id"
  fi
  [[ "$observed_cluster_id" == "$cluster_id" ]] \
    || fail "manager Agents reported different Swarm cluster IDs"

  node_ids+=("$observed_node_id")
  if [[ "$observed_leader" == "true" ]]; then
    leader_count=$((leader_count + 1))
  fi
done

unique_nodes="$(printf '%s\n' "${node_ids[@]}" | sort -u | wc -l | tr -d ' ')"
[[ "$unique_nodes" == "3" ]] \
  || fail "expected three distinct local manager node IDs, got $unique_nodes"
[[ "$leader_count" == "1" ]] \
  || fail "expected exactly one Agent to observe itself as leader, got $leader_count"


log "starting disposable MySQL registration store on isolated manager network"
REGISTRATION_DB_ID="$(docker run -d --name "$REGISTRATION_DB_CONTAINER" --network "$NETWORK_NAME" -p "127.0.0.1:${REGISTRATION_DB_PORT}:3306" -e MYSQL_ROOT_PASSWORD=docklane-root -e MYSQL_DATABASE=docklane -e MYSQL_USER=docklane -e MYSQL_PASSWORD=docklane-test mysql:8.4)"
printf '%s\n' "$REGISTRATION_DB_ID" >"$OWNERSHIP_DIR/manager-db.container-id"
# A local mysqladmin ping can succeed against the temporary --skip-networking
# initialization server. Require final TCP availability and a working SQL user.
registration_db_ready=false
for _ in {1..90}; do
  if docker exec "$REGISTRATION_DB_CONTAINER" mysql --protocol=TCP -h127.0.0.1 \
      -udocklane -pdocklane-test docklane --batch --skip-column-names \
      -e 'SELECT 1' 2>/dev/null | grep -qx '1' &&
      ( : >"/dev/tcp/127.0.0.1/$REGISTRATION_DB_PORT" ) 2>/dev/null; then
    registration_db_ready=true
    break
  fi
  sleep 1
done
[[ "$registration_db_ready" == "true" ]] || fail "registration DB TCP on host loopback did not become ready"

log "verifying Control Plane Agent failover after primary Agent loss"
# This disposable fixture already checked the ID against all three Docker managers.
DOCKLANE_EXPECTED_CLUSTER_ID="$cluster_id" \
DOCKLANE_CLUSTER_ID=default \
DOCKLANE_CLUSTER_REGISTRATION_MODE=enforce \
DOCKLANE_DATABASE_URL="mysql://docklane:docklane-test@127.0.0.1:${REGISTRATION_DB_PORT}/docklane" \
DOCKLANE_MANAGER_AGENT_URLS="$(printf '[{"id":"manager-01","baseUrl":"https://127.0.0.1:%s"},{"id":"manager-02","baseUrl":"https://127.0.0.1:%s"},{"id":"manager-03","baseUrl":"https://127.0.0.1:%s"}]' "$MANAGER_01_AGENT_PORT" "$MANAGER_02_AGENT_PORT" "$MANAGER_03_AGENT_PORT")" \
DOCKLANE_AGENT_CA_FILE="$CA_CERT" \
DOCKLANE_AGENT_CERT_FILE="$CLIENT_CERT" \
DOCKLANE_AGENT_KEY_FILE="$CLIENT_KEY" \
DOCKLANE_MANAGER_01_CONTAINER="$MANAGER_01_CONTAINER" \
DOCKLANE_FAILOVER_EVIDENCE="$LOG_DIR/manager-agent-failover.json" \
node "$ROOT_DIR/tests/operational-readiness/manager-agents-registration.mjs"

cat >"$LOG_DIR/manager-agents-summary.txt" <<EOF
three-manager topology: PASS
manager-01 Agent identity: PASS
manager-02 Agent identity: PASS
manager-03 Agent identity: PASS
distinct local manager nodes: PASS
shared Swarm cluster: PASS
single observed leader: PASS
Control Plane primary Agent loss failover: PASS
registered enforcement across Agent failover: PASS
persisted immutable registration and audit: PASS
cluster id: $cluster_id
EOF

log "manager-specific Go Agent deployment scenario passed"
cat "$LOG_DIR/manager-agents-summary.txt"
