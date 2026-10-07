#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
AGENT_ADDR="127.0.0.1:19443"
AGENT_URL="https://$AGENT_ADDR"
AGENT_PID=""

cleanup() {
  if [[ -n "$AGENT_PID" ]] && kill -0 "$AGENT_PID" 2>/dev/null; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf '[mtls-poc] ERROR: %s\n' "$*" >&2
  exit 1
}

for command in openssl curl jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

[[ -x "$ROOT_DIR/agent/bin/docklane-agent" ]] || fail "agent binary is missing; build agent/bin/docklane-agent first"
[[ -f "$ROOT_DIR/apps/api/dist/agent/http-agent.client.js" ]] || fail "API build output is missing; build @docklane/api first"

CA_KEY="$TMP_DIR/ca.key"
CA_CERT="$TMP_DIR/ca.crt"
SERVER_KEY="$TMP_DIR/server.key"
SERVER_CSR="$TMP_DIR/server.csr"
SERVER_CERT="$TMP_DIR/server.crt"
CLIENT_KEY="$TMP_DIR/client.key"
CLIENT_CSR="$TMP_DIR/client.csr"
CLIENT_CERT="$TMP_DIR/client.crt"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_KEY" >/dev/null 2>&1
openssl req -x509 -new -sha256 -days 1 \
  -key "$CA_KEY" \
  -subj '/CN=Docklane Functional Test CA' \
  -out "$CA_CERT" >/dev/null 2>&1

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$SERVER_KEY" >/dev/null 2>&1
openssl req -new -sha256 \
  -key "$SERVER_KEY" \
  -subj '/CN=127.0.0.1' \
  -out "$SERVER_CSR" >/dev/null 2>&1
cat >"$TMP_DIR/server.ext" <<'EOF'
subjectAltName=IP:127.0.0.1
extendedKeyUsage=serverAuth
keyUsage=digitalSignature
EOF
openssl x509 -req -sha256 -days 1 \
  -in "$SERVER_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -extfile "$TMP_DIR/server.ext" \
  -out "$SERVER_CERT" >/dev/null 2>&1

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CLIENT_KEY" >/dev/null 2>&1
openssl req -new -sha256 \
  -key "$CLIENT_KEY" \
  -subj '/CN=docklane-control-plane' \
  -out "$CLIENT_CSR" >/dev/null 2>&1
cat >"$TMP_DIR/client.ext" <<'EOF'
extendedKeyUsage=clientAuth
keyUsage=digitalSignature
EOF
openssl x509 -req -sha256 -days 1 \
  -in "$CLIENT_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -extfile "$TMP_DIR/client.ext" \
  -out "$CLIENT_CERT" >/dev/null 2>&1

(
  export DOCKLANE_AGENT_ADDR="$AGENT_ADDR"
  export DOCKLANE_AGENT_TLS_CERT_FILE="$SERVER_CERT"
  export DOCKLANE_AGENT_TLS_KEY_FILE="$SERVER_KEY"
  export DOCKLANE_AGENT_TLS_CA_FILE="$CA_CERT"
  unset DOCKLANE_AGENT_INSECURE_DEV
  exec "$ROOT_DIR/agent/bin/docklane-agent"
) >"$TMP_DIR/agent.log" 2>&1 &
AGENT_PID="$!"

for _ in {1..50}; do
  if curl -fsS \
    --cacert "$CA_CERT" \
    --cert "$CLIENT_CERT" \
    --key "$CLIENT_KEY" \
    "$AGENT_URL/v1/health" \
    >"$TMP_DIR/curl-health.json" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    cat "$TMP_DIR/agent.log" >&2 || true
    fail "Agent stopped before secure health endpoint became ready"
  fi
  sleep 0.2
done

jq -e '.status == "ok" and .component == "docklane-agent"' "$TMP_DIR/curl-health.json" >/dev/null \
  || fail "mTLS curl health check did not return the Agent health contract"

if curl -fsS \
  --cacert "$CA_CERT" \
  "$AGENT_URL/v1/health" \
  >"$TMP_DIR/no-client-cert.out" 2>"$TMP_DIR/no-client-cert.err"; then
  fail "Agent accepted a TLS connection without a client certificate"
fi

# This fixture checks transport/liveness only and does not create a Swarm.
# The configured sentinel is not evidence that cluster identity was verified.
CONTROL_PLANE_HEALTH="$(
  DOCKLANE_EXPECTED_CLUSTER_ID="mtls-health-only" \
  DOCKLANE_AGENT_URL="$AGENT_URL" \
  DOCKLANE_AGENT_CA_FILE="$CA_CERT" \
  DOCKLANE_AGENT_CERT_FILE="$CLIENT_CERT" \
  DOCKLANE_AGENT_KEY_FILE="$CLIENT_KEY" \
  node --input-type=module <<'NODE'
const { HttpAgentClient } = await import('./apps/api/dist/agent/http-agent.client.js');
const health = await new HttpAgentClient().health();
process.stdout.write(JSON.stringify(health));
NODE
)"

jq -e '.status == "ok" and .component == "docklane-agent"' <<<"$CONTROL_PLANE_HEALTH" >/dev/null \
  || fail "Control Plane HttpAgentClient did not complete the mTLS health request"

printf '%s\n' "Control Plane -> Go Agent mTLS handshake: PASS"
printf '%s\n' "Missing client certificate rejection: PASS"
