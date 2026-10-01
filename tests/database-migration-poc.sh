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

  const legacyTokens = [
    {
      id: 'legacy-valid',
      tokenHash: '1'.repeat(64),
      claimId: 'claim-valid',
    },
    {
      id: 'legacy-wrong-claim',
      tokenHash: '2'.repeat(64),
      claimId: 'claim-current',
    },
    {
      id: 'legacy-duplicate-audit',
      tokenHash: '3'.repeat(64),
      claimId: 'claim-duplicate',
    },
    {
      id: 'legacy-wrong-cluster',
      tokenHash: '4'.repeat(64),
      claimId: 'claim-cluster',
    },
  ];

  for (const token of legacyTokens) {
    await db.pool.execute(
      `INSERT INTO bootstrap_tokens
       (
         id, token_hash, cluster_id, node_role, labels_json, created_by,
         expires_at, used_at, claim_id, completed_node_id
       )
       VALUES (?, ?, 'cluster-1', 'worker', JSON_OBJECT(), 'admin-1',
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY),
               UTC_TIMESTAMP(6), ?, NULL)`,
      [token.id, token.tokenHash, token.claimId],
    );
  }

  const insertCompletionAudit = async ({
    tokenId,
    clusterId = 'cluster-1',
    claimId,
    nodeId,
  }) => {
    await db.pool.execute(
      `INSERT INTO audit_events
       (
         operation_id, actor_id, cluster_id, service_id,
         resource_type, resource_id, action, before_json, after_json
       )
       VALUES (?, ?, ?, ?, 'bootstrap_token', ?, 'BOOTSTRAP_COMPLETED', NULL, ?)`,
      [
        tokenId,
        `bootstrap:${tokenId}`,
        clusterId,
        tokenId,
        tokenId,
        JSON.stringify({
          claimId,
          nodeId,
          hostname: `${nodeId}.example`,
          role: 'worker',
          labels: {},
          verifiedAt: '2026-09-30T00:01:00.000Z',
        }),
      ],
    );
  };

  await insertCompletionAudit({
    tokenId: 'legacy-valid',
    claimId: 'claim-valid',
    nodeId: 'node-valid',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-wrong-claim',
    claimId: 'claim-stale',
    nodeId: 'node-stale',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-duplicate-audit',
    claimId: 'claim-duplicate',
    nodeId: 'node-a',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-duplicate-audit',
    claimId: 'claim-duplicate',
    nodeId: 'node-b',
  });
  await insertCompletionAudit({
    tokenId: 'legacy-wrong-cluster',
    clusterId: 'cluster-2',
    claimId: 'claim-cluster',
    nodeId: 'node-cluster',
  });

  await db.pool.execute('DELETE FROM schema_migrations WHERE version = 2');

  await db.onModuleInit();
  await db.onModuleInit();

  const [legacyRows] = await db.pool.query(
    `SELECT id, completed_node_id
     FROM bootstrap_tokens
     WHERE id LIKE 'legacy-%'
     ORDER BY id`,
  );
  const completedNodeByToken = new Map(
    legacyRows.map((row) => [row.id, row.completed_node_id]),
  );
  assert.equal(completedNodeByToken.get('legacy-valid'), 'node-valid');
  assert.equal(completedNodeByToken.get('legacy-wrong-claim'), null);
  assert.equal(completedNodeByToken.get('legacy-duplicate-audit'), null);
  assert.equal(completedNodeByToken.get('legacy-wrong-cluster'), null);

  const [migrationRows] = await db.pool.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  assert.equal(migrationRows.length, 2);
  assert.deepEqual(
    migrationRows.map((row) => [Number(row.version), row.name]),
    [
      [1, 'baseline-current-schema'],
      [2, 'backfill-bootstrap-completed-node-id'],
    ],
  );
  for (const row of migrationRows) {
    assert.match(row.checksum, /^[a-f0-9]{64}$/);
  }

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
