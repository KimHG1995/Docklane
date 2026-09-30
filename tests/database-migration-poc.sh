#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="docklane-db-migration-poc"
MYSQL_PORT="33307"
MYSQL_PASSWORD="docklane"
DATABASE_URL="mysql://root:${MYSQL_PASSWORD}@127.0.0.1:${MYSQL_PORT}/docklane"
container_id=""

cleanup() {
  local status="$?"
  trap - EXIT

  if [[ "$status" != "0" && -n "$container_id" ]]; then
    echo "database migration PoC MySQL logs:" >&2
    docker logs "$container_id" >&2 || true
  fi

  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi

  exit "$status"
}
trap cleanup EXIT

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "database migration PoC refuses to remove pre-existing container: $CONTAINER_NAME" >&2
  exit 1
fi

container_id="$(docker run -d   --name "$CONTAINER_NAME"   -e MYSQL_ROOT_PASSWORD="$MYSQL_PASSWORD"   -e MYSQL_DATABASE=docklane   -p "127.0.0.1:${MYSQL_PORT}:3306"   mysql:8.4)"

for _ in {1..90}; do
  pid_one="$(docker exec "$container_id" sh -c 'cat /proc/1/comm' 2>/dev/null || true)"
  if [[ "$pid_one" == "mysqld" ]] &&
     docker exec "$container_id" mysqladmin ping -uroot -p"$MYSQL_PASSWORD" --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

pid_one="$(docker exec "$container_id" sh -c 'cat /proc/1/comm' 2>/dev/null || true)"
[[ "$pid_one" == "mysqld" ]] || { echo "MySQL entrypoint did not reach final mysqld process" >&2; exit 1; }

docker exec "$container_id" mysqladmin ping -uroot -p"$MYSQL_PASSWORD" --silent >/dev/null 2>&1   || { echo "MySQL did not become ready" >&2; exit 1; }

cd "$ROOT_DIR"

DOCKLANE_DATABASE_URL="$DATABASE_URL" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { Database } from './apps/api/dist/db/database.js';

const db = new Database();

try {
  await db.onModuleInit();
  await db.onModuleInit();

  const [migrationRows] = await db.pool.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  assert.equal(migrationRows.length, 1);
  assert.equal(Number(migrationRows[0].version), 1);
  assert.equal(migrationRows[0].name, 'baseline-current-schema');
  assert.match(migrationRows[0].checksum, /^[a-f0-9]{64}$/);

  const expectedTables = [
    'applications',
    'audit_events',
    'bootstrap_tokens',
    'deployment_targets',
    'deployments',
    'node_operations',
    'operations',
    'releases',
    'schema_migrations',
  ];

  const [tableRows] = await db.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN (${expectedTables.map(() => '?').join(',')})`,
    expectedTables,
  );
  assert.deepEqual(
    tableRows.map((row) => row.TABLE_NAME ?? row.table_name).sort(),
    [...expectedTables].sort(),
  );

  const requiredColumns = [
    ['audit_events', 'resource_type'],
    ['audit_events', 'resource_id'],
    ['bootstrap_tokens', 'claim_id'],
    ['bootstrap_tokens', 'completed_node_id'],
    ['deployments', 'kind'],
    ['deployments', 'source_deployment_id'],
    ['deployments', 'rollback_operation_id'],
    ['node_operations', 'target_labels'],
    ['node_operations', 'label_patch'],
    ['operations', 'target_runtime_spec_hash'],
  ];

  for (const [tableName, columnName] of requiredColumns) {
    const [rows] = await db.pool.query(
      `SELECT COUNT(*) AS count
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND column_name = ?`,
      [tableName, columnName],
    );
    assert.equal(Number(rows[0].count), 1, `${tableName}.${columnName} missing`);
  }

  await db.pool.execute(
    `INSERT INTO schema_migrations (version, name, checksum)
     VALUES (999, 'future-schema', ?)`,
    ['f'.repeat(64)],
  );

  const futureDb = new Database();
  try {
    await assert.rejects(
      () => futureDb.onModuleInit(),
      /newer than this Docklane build/,
    );
  } finally {
    await futureDb.onModuleDestroy();
  }

  await db.pool.execute('DELETE FROM schema_migrations WHERE version = 999');

  console.log('database migration PoC: PASS');
} finally {
  await db.onModuleDestroy();
}
NODE
