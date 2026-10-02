#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${DOCKLANE_OR_LOG_DIR:-${RUNNER_TEMP:-/tmp}/docklane-operational-readiness}"
OWN="$LOG/ownership-db-restore"
BACKUP="${DOCKLANE_OR_PRIVATE_BACKUP_DIR:-${RUNNER_TEMP:-/tmp}/docklane-db-backup-private-${GITHUB_RUN_ID:-local}}"
SOURCE="docklane-or-db-source"
RESTORE="docklane-or-db-restore"
IMAGE="${DOCKLANE_OR_MYSQL_IMAGE:-mysql:8.4}"
PASSWORD="${DOCKLANE_OR_MYSQL_PASSWORD:-docklane-restore-test}"
SOURCE_PORT="${DOCKLANE_OR_DB_SOURCE_PORT:-33308}"
RESTORE_PORT="${DOCKLANE_OR_DB_RESTORE_PORT:-33309}"
SOURCE_URL="mysql://root:${PASSWORD}@127.0.0.1:${SOURCE_PORT}/docklane"
RESTORE_URL="mysql://root:${PASSWORD}@127.0.0.1:${RESTORE_PORT}/docklane"

export DOCKLANE_OR_LOG_DIR="$LOG"
export DOCKLANE_OR_PRIVATE_BACKUP_DIR="$BACKUP"

log(){ printf '[operational-readiness] %s\n' "$*"; }
fail(){ printf '[operational-readiness] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup(){
  bash "$ROOT/tests/operational-readiness/db-restore-cleanup.sh" || true
}

record_container(){
  printf '%s\n' "$2" >"$OWN/$1.container-id"
}

wait_mysql(){
  local container="$1"
  for _ in {1..120}; do
    if docker exec -e MYSQL_PWD="$PASSWORD" "$container" \
      mysqladmin ping -uroot --silent >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "MySQL did not become ready: $container"
}

start_mysql(){
  local name="$1" port="$2" create_database="$3" id
  local args=(
    run -d --name "$name"
    -e "MYSQL_ROOT_PASSWORD=$PASSWORD"
    -p "127.0.0.1:${port}:3306"
  )
  if [[ "$create_database" == true ]]; then
    args+=( -e MYSQL_DATABASE=docklane )
  fi
  args+=( "$IMAGE" )
  id="$(docker "${args[@]}")"
  record_container "$name" "$id"
  wait_mysql "$name"
}

for name in "$SOURCE" "$RESTORE"; do
  docker inspect "$name" >/dev/null 2>&1 && fail "container already exists: $name"
done

mkdir -p "$LOG" "$OWN"
case "$(basename "$BACKUP")" in
  docklane-db-backup-private-*) ;;
  *) fail "unsafe private backup path" ;;
esac
rm -rf "$BACKUP"
mkdir -p "$BACKUP"
chmod 0700 "$BACKUP"
trap cleanup EXIT

cd "$ROOT"

log "starting source MySQL"
start_mysql "$SOURCE" "$SOURCE_PORT" true

log "applying Docklane migrations to source database"
DOCKLANE_DATABASE_URL="$SOURCE_URL" node --input-type=module <<'NODE'
import { Database } from './apps/api/dist/db/database.js';
const db = new Database();
try {
  await db.onModuleInit();
} finally {
  await db.onModuleDestroy();
}
NODE

log "seeding representative Docklane state"
docker exec -i -e MYSQL_PWD="$PASSWORD" "$SOURCE" mysql -uroot docklane <<'SQL'
INSERT INTO applications (id, name, description, created_at, updated_at)
VALUES ('app-restore', 'restore-app', 'db restore marker', '2026-10-02 00:00:00.123456', '2026-10-02 00:00:01.123456');

INSERT INTO deployment_targets
(id, application_id, cluster_id, environment, docker_service_id, service_name, routing_mode, created_at, updated_at)
VALUES
('target-restore', 'app-restore', 'cluster-restore', 'prod', 'service-restore', 'restore-api', 'ingress',
 '2026-10-02 00:01:00.123456', '2026-10-02 00:01:01.123456');

INSERT INTO releases
(id, application_id, version, image_repository, image_tag, image_digest, git_commit, build_number, created_by, created_at)
VALUES
('release-restore', 'app-restore', '1.0.0', 'example.invalid/docklane/restore', '1.0.0',
 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 'restore-commit', 'restore-build-1', 'operator-restore', '2026-10-02 00:02:00.123456');

INSERT INTO operations
(id, cluster_id, service_id, type, status, actor_id, expected_version,
 before_spec_hash, target_spec_hash, target_force_update, target_replicas,
 target_image, target_task_spec_hash, target_runtime_spec_hash, result_version,
 error_code, error_message, created_at, updated_at)
VALUES
('operation-restore', 'cluster-restore', 'service-restore', 'DEPLOY', 'SUCCESS', 'operator-restore', 7,
 'before-hash', 'target-hash', 1, 2,
 'example.invalid/docklane/restore@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 'task-hash', 'runtime-hash', 8, NULL, NULL,
 '2026-10-02 00:03:00.123456', '2026-10-02 00:03:01.123456');

INSERT INTO deployments
(id, kind, source_deployment_id, release_id, previous_release_id, deployment_target_id,
 operation_id, rollback_operation_id, status, reason, no_op, before_spec, target_spec,
 health_json, expected_service_version, started_at, finished_at, created_by, created_at)
VALUES
('deployment-restore', 'DEPLOY', NULL, 'release-restore', NULL, 'target-restore',
 'operation-restore', NULL, 'SUCCESS', NULL, FALSE,
 JSON_OBJECT('image', 'before'), JSON_OBJECT('image', 'target'),
 JSON_OBJECT('type', 'http', 'path', '/health'), 7,
 '2026-10-02 00:04:00.123456', '2026-10-02 00:05:00.123456',
 'operator-restore', '2026-10-02 00:04:00.123456');

INSERT INTO bootstrap_tokens
(id, token_hash, cluster_id, node_role, labels_json, created_by, expires_at,
 used_at, claim_id, completed_node_id, created_at)
VALUES
('bootstrap-restore', REPEAT('b', 64), 'cluster-restore', 'worker', JSON_OBJECT('zone', 'restore'),
 'admin-restore', '2026-10-03 00:00:00.123456', '2026-10-02 00:06:00.123456',
 'claim-restore', 'node-restore', '2026-10-02 00:05:30.123456');

INSERT INTO audit_events
(operation_id, actor_id, cluster_id, service_id, resource_type, resource_id,
 action, before_json, after_json, created_at)
VALUES
('operation-restore', 'operator-restore', 'cluster-restore', 'service-restore',
 'service', 'service-restore', 'DEPLOYMENT_SUCCEEDED',
 JSON_OBJECT('version', 7), JSON_OBJECT('version', 8), '2026-10-02 00:05:01.123456'),
('bootstrap-restore', 'bootstrap:bootstrap-restore', 'cluster-restore', 'bootstrap-restore',
 'bootstrap_token', 'bootstrap-restore', 'BOOTSTRAP_COMPLETED', NULL,
 JSON_OBJECT('claimId', 'claim-restore', 'nodeId', 'node-restore'), '2026-10-02 00:06:01.123456');
SQL

log "capturing source database fingerprint"
DOCKLANE_DATABASE_URL="$SOURCE_URL" DOCKLANE_DB_RESTORE_EVIDENCE="$LOG/source-database-state.json" \
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Database } from './apps/api/dist/db/database.js';

const db = new Database();
try {
  await db.onModuleInit();
  const [migrations] = await db.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const [rows] = await db.query(`
    SELECT
      a.id AS application_id,
      t.id AS target_id,
      r.id AS release_id,
      o.id AS operation_id,
      o.status AS operation_status,
      d.id AS deployment_id,
      d.status AS deployment_status,
      DATE_FORMAT(d.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS deployment_created_at,
      b.id AS bootstrap_id,
      b.claim_id,
      b.completed_node_id,
      (SELECT COUNT(*) FROM audit_events) AS audit_count
    FROM applications a
    JOIN deployment_targets t ON t.application_id = a.id
    JOIN releases r ON r.application_id = a.id
    JOIN deployments d ON d.release_id = r.id AND d.deployment_target_id = t.id
    JOIN operations o ON o.id = d.operation_id
    JOIN bootstrap_tokens b ON b.id = 'bootstrap-restore'
    WHERE a.id = 'app-restore'
  `);
  assert.equal(rows.length, 1);
  writeFileSync(process.env.DOCKLANE_DB_RESTORE_EVIDENCE, JSON.stringify({ migrations, state: rows[0] }, null, 2) + '\n');
} finally {
  await db.onModuleDestroy();
}
NODE

log "creating logical MySQL backup"
docker exec -e MYSQL_PWD="$PASSWORD" "$SOURCE" \
  mysqldump -uroot --single-transaction --routines --triggers --hex-blob --databases docklane \
  >"$BACKUP/docklane.sql"
[[ -s "$BACKUP/docklane.sql" ]] || fail "database backup is empty"
sha256sum "$BACKUP/docklane.sql" | awk '{print $1}' >"$LOG/database-backup.sha256"
printf '%s\n' 'SQL backup bytes are excluded from uploaded evidence and deleted during cleanup.' \
  >"$LOG/database-backup-handling.txt"

log "simulating loss of source database"
docker rm -f "$SOURCE" >"$LOG/source-database-remove.log"
rm -f "$OWN/$SOURCE.container-id"

log "starting clean restore MySQL"
start_mysql "$RESTORE" "$RESTORE_PORT" false

log "restoring logical backup into clean database"
docker exec -i -e MYSQL_PWD="$PASSWORD" "$RESTORE" mysql -uroot <"$BACKUP/docklane.sql"

log "starting Docklane database layer against restored database"
DOCKLANE_DATABASE_URL="$RESTORE_URL" DOCKLANE_DB_RESTORE_SOURCE="$LOG/source-database-state.json" \
DOCKLANE_DB_RESTORE_EVIDENCE="$LOG/restored-database-state.json" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from './apps/api/dist/db/database.js';

const source = JSON.parse(readFileSync(process.env.DOCKLANE_DB_RESTORE_SOURCE, 'utf8'));
const db = new Database();
try {
  await db.onModuleInit();
  const [migrations] = await db.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const [rows] = await db.query(`
    SELECT
      a.id AS application_id,
      t.id AS target_id,
      r.id AS release_id,
      o.id AS operation_id,
      o.status AS operation_status,
      d.id AS deployment_id,
      d.status AS deployment_status,
      DATE_FORMAT(d.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS deployment_created_at,
      b.id AS bootstrap_id,
      b.claim_id,
      b.completed_node_id,
      (SELECT COUNT(*) FROM audit_events) AS audit_count
    FROM applications a
    JOIN deployment_targets t ON t.application_id = a.id
    JOIN releases r ON r.application_id = a.id
    JOIN deployments d ON d.release_id = r.id AND d.deployment_target_id = t.id
    JOIN operations o ON o.id = d.operation_id
    JOIN bootstrap_tokens b ON b.id = 'bootstrap-restore'
    WHERE a.id = 'app-restore'
  `);
  assert.equal(rows.length, 1);
  const restored = { migrations, state: rows[0] };
  assert.deepEqual(restored, source);
  assert.equal(restored.state.operation_status, 'SUCCESS');
  assert.equal(restored.state.deployment_status, 'SUCCESS');
  assert.equal(restored.state.claim_id, 'claim-restore');
  assert.equal(restored.state.completed_node_id, 'node-restore');
  assert.equal(Number(restored.state.audit_count), 2);
  writeFileSync(process.env.DOCKLANE_DB_RESTORE_EVIDENCE, JSON.stringify(restored, null, 2) + '\n');
} finally {
  await db.onModuleDestroy();
}
NODE

cat >"$LOG/db-restore-summary.txt" <<SUMMARY
source migrations applied: PASS
representative Docklane state seeded: PASS
consistent logical backup created: PASS
source database removed: PASS
backup restored into clean MySQL: PASS
Docklane database layer restarted after restore: PASS
migration metadata preserved: PASS
application/target/release relationships preserved: PASS
operation/deployment state preserved: PASS
bootstrap claim/node binding preserved: PASS
audit records preserved: PASS
microsecond timestamp preserved: PASS
private SQL backup excluded from artifacts: PASS
SUMMARY

log "Docklane DB restore drill passed"
cat "$LOG/db-restore-summary.txt"
