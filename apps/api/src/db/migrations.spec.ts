import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE_MIGRATIONS,
  assertMigrationCatalog,
  migrationChecksum,
  runDatabaseMigrations,
} from './migrations.js';

type Applied = {
  version: number;
  name: string;
  checksum: string;
};

function fakeConnection(options?: {
  lock?: boolean;
  applied?: Applied[];
  dispatchIndex?: 'valid' | 'invalid';
}) {
  const applied = [...(options?.applied ?? [])];
  const queries: string[] = [];
  const executes: string[] = [];

  const connection = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);

      if (sql.startsWith('SELECT GET_LOCK')) {
        return [[{ acquired: options?.lock === false ? 0 : 1 }], []];
      }
      if (sql.startsWith('SELECT RELEASE_LOCK')) {
        return [[{ released: 1 }], []];
      }
      if (sql.includes('FROM schema_migrations')) {
        return [[...applied], []];
      }
      if (sql.includes('information_schema.columns')) {
        return [[{ count: 1 }], []];
      }
      if (sql.includes('information_schema.statistics')) {
        // The v8 uniqueness migration reads index metadata, unlike the
        // baseline migrations that only SELECT COUNT(*) for existing indexes.
        if (sql.includes("index_name = 'uq_maintenance_dispatch_operation'")) {
          if (options?.dispatchIndex === 'valid') {
            return [[
              { column_name: 'cluster_id', non_unique: 0, seq_in_index: 1 },
              { column_name: 'operation_id', non_unique: 0, seq_in_index: 2 },
            ], []];
          }
          if (options?.dispatchIndex === 'invalid') {
            return [[{ column_name: 'cluster_id', non_unique: 1, seq_in_index: 1 }], []];
          }
          return [[], []]; // Fresh database: the unique index is not present.
        }
        return [[{ count: 1 }], []];
      }

      return [[], []];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executes.push(sql);
      if (sql.includes('INSERT INTO schema_migrations')) {
        const [version, name, checksum] = params as [
          number,
          string,
          string,
        ];
        applied.push({ version, name, checksum });
      }
      return [{ affectedRows: 1 }, []];
    },
  };

  return { connection, applied, queries, executes };
}

test('database migrations apply all known migrations once and skip them on replay', async () => {
  const state = fakeConnection();

  await runDatabaseMigrations(state.connection as never);
  assert.deepEqual(
    state.applied.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );

  const insertsAfterFirst = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterFirst, 9);

  await runDatabaseMigrations(state.connection as never);

  const insertsAfterReplay = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterReplay, 9);
});

test('database migrations reject metadata drift for an applied migration', async () => {
  const migration = DATABASE_MIGRATIONS[0]!;
  const state = fakeConnection({
    applied: [
      {
        version: migration.version,
        name: migration.name,
        checksum: '0'.repeat(64),
      },
    ],
  });

  await assert.rejects(
    () => runDatabaseMigrations(state.connection as never),
    /metadata does not match/,
  );
});

test('database migrations reject a database newer than the running build', async () => {
  const state = fakeConnection({
    applied: [
      {
        version: 999,
        name: 'future',
        checksum: 'f'.repeat(64),
      },
    ],
  });

  await assert.rejects(
    () => runDatabaseMigrations(state.connection as never),
    /newer than this Docklane build/,
  );
});

test('database migrations fail when the advisory lock cannot be acquired', async () => {
  const state = fakeConnection({ lock: false });

  await assert.rejects(
    () => runDatabaseMigrations(state.connection as never),
    /Could not acquire Docklane database migration lock/,
  );
});

test('migration checksums are deterministic and catalog metadata is stable', () => {
  const baseline = DATABASE_MIGRATIONS[0]!;
  const backfill = DATABASE_MIGRATIONS[1]!;

  assert.equal(migrationChecksum(baseline), migrationChecksum(baseline));
  assert.equal(migrationChecksum(backfill), migrationChecksum(backfill));
  assert.match(migrationChecksum(baseline), /^[a-f0-9]{64}$/);
  assert.match(migrationChecksum(backfill), /^[a-f0-9]{64}$/);
  assert.deepEqual(
    DATABASE_MIGRATIONS.map((migration) => [migration.version, migration.name]),
    [
      [1, 'baseline-current-schema'],
      [2, 'backfill-bootstrap-completed-node-id'],
      [3, 'cluster-registration'],
      [4, 'rollback-attempt-history'],
      [5, 'cluster-maintenance-state'],
      [6, 'maintenance-owner-unicode'],
      [7, 'maintenance-dispatch-evidence'],
      [8, 'maintenance-dispatch-uniqueness'],
      [9, 'maintenance-active-admissions'],
    ],
  );
});

test('bootstrap completion backfill validates claim, node and audit uniqueness', async () => {
  const state = fakeConnection();

  await runDatabaseMigrations(state.connection as never);

  const backfillQuery = state.queries.find((sql) =>
    sql.includes('UPDATE bootstrap_tokens AS token'),
  );
  assert.ok(backfillQuery);
  assert.ok(backfillQuery.includes("action = 'BOOTSTRAP_COMPLETED'"));
  assert.ok(backfillQuery.includes("resource_type = 'bootstrap_token'"));
  assert.ok(backfillQuery.includes('HAVING COUNT(*) = 1'));
  assert.ok(
    backfillQuery.includes(
      "JSON_UNQUOTE(JSON_EXTRACT(audit.after_json, '$.claimId')) = token.claim_id",
    ),
  );
  assert.ok(
    backfillQuery.includes(
      "JSON_TYPE(JSON_EXTRACT(audit.after_json, '$.nodeId')) = 'STRING'",
    ),
  );
  assert.ok(backfillQuery.includes('audit.cluster_id = token.cluster_id'));
  assert.ok(backfillQuery.includes('audit.resource_id = token.id'));
});


test('migration catalog rejects non-contiguous versions', () => {
  assert.throws(
    () =>
      assertMigrationCatalog([
        { version: 1, name: 'one', signature: 'one' },
        { version: 3, name: 'three', signature: 'three' },
      ]),
    /must be contiguous/,
  );
});

test('cluster registration migration is additive, unique and case-sensitive', async () => {
  const state = fakeConnection({ applied: DATABASE_MIGRATIONS.slice(0, 2).map((m) => ({
    version: m.version, name: m.name, checksum: migrationChecksum(m),
  })) });
  await runDatabaseMigrations(state.connection as never);
  const query = state.queries.find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS cluster_registrations'));
  assert.ok(query, 'cluster registration schema is missing');
  assert.match(query, /cluster_id VARCHAR\(128\).*PRIMARY KEY/);
  assert.match(query, /COLLATE ascii_bin/);
  assert.match(query, /UNIQUE KEY uq_cluster_registration_swarm \(swarm_cluster_id\)/);
  assert.equal(state.queries.some((sql) => sql.includes('UPDATE bootstrap_tokens')), false);
  assert.equal(state.executes.filter((sql) => sql.includes('INSERT INTO schema_migrations')).length, 7);
});

test('rollback history migration persists each attempt mapping and backfills only matching operations', async () => {
  const state = fakeConnection({ applied: DATABASE_MIGRATIONS.slice(0, 3).map(m => ({
    version: m.version, name: m.name, checksum: migrationChecksum(m),
  })) });
  await runDatabaseMigrations(state.connection as never);
  const create = state.queries.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS rollback_attempts'));
  assert.ok(create);
  assert.match(create, /operation_id VARCHAR\(64\) PRIMARY KEY/);
  const backfill = state.queries.find(sql => sql.includes('INSERT INTO rollback_attempts'));
  assert.ok(backfill);
  assert.match(backfill, /o.type = 'ROLLBACK'/);
  assert.match(backfill, /o.cluster_id = t.cluster_id/);
  assert.match(backfill, /o.service_id = t.docker_service_id/);
});


test('maintenance migration adds persistent fail-closed state without auto-opening clusters', async () => {
  const state = fakeConnection({ applied: DATABASE_MIGRATIONS.slice(0, 4).map(m => ({ version:m.version, name:m.name, checksum:migrationChecksum(m) })) });
  await runDatabaseMigrations(state.connection as never);
  const query = state.queries.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS cluster_maintenance_states'));
  assert.ok(query, 'maintenance state schema is missing');
  assert.match(query, /FOREIGN KEY \(cluster_id\) REFERENCES cluster_registrations\(cluster_id\)/);
  assert.match(query, /ENUM\('OPEN', 'CLOSING', 'CLOSED', 'RECONCILING'\)/);
  assert.match(query, /generation BIGINT UNSIGNED NOT NULL/);
  assert.equal(state.queries.some(sql => sql.includes('INSERT INTO cluster_maintenance_states')), false);
});


test('maintenance Unicode owner migration does not change immutable v5', async () => {
  const state = fakeConnection({ applied: DATABASE_MIGRATIONS.slice(0, 5).map(m => ({ version:m.version, name:m.name, checksum:migrationChecksum(m) })) });
  await runDatabaseMigrations(state.connection as never);
  const ddl = state.queries.find(sql => sql.includes('ALTER TABLE cluster_maintenance_states'));
  assert.ok(ddl);
  assert.ok(ddl.includes('owner_id VARCHAR(128)'));
  assert.match(ddl, /CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/);
  assert.equal(state.executes.filter(sql => sql.includes('INSERT INTO schema_migrations')).length, 4);
});

test('maintenance dispatch evidence migration records uncertainty and barriers without auto-acknowledgement', async () => {
  const state = fakeConnection({
    applied: DATABASE_MIGRATIONS.slice(0, 6).map(m => ({
      version: m.version, name: m.name, checksum: migrationChecksum(m),
    })),
  });
  await runDatabaseMigrations(state.connection as never);
  const dispatch = state.queries.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS maintenance_dispatches'));
  const barrier = state.queries.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS maintenance_agent_barriers'));
  assert.ok(dispatch);
  assert.ok(barrier);
  assert.match(dispatch, /'PREPARED','SENDING','ACKNOWLEDGED','REJECTED','UNCERTAIN'/);
  assert.match(barrier, /PRIMARY KEY \(cluster_id, agent_id\)/);
  assert.equal(state.queries.some(sql => sql.includes('INSERT INTO maintenance_agent_barriers')), false);
});


test('dispatch unique-index migration skips an already-created valid index', async () => {
  const state = fakeConnection({
    dispatchIndex: 'valid',
    applied: DATABASE_MIGRATIONS.slice(0, 7).map(m => ({
      version: m.version, name: m.name, checksum: migrationChecksum(m),
    })),
  });
  await runDatabaseMigrations(state.connection as never);
  assert.equal(state.queries.some(sql => sql.includes('ADD UNIQUE KEY uq_maintenance_dispatch_operation')), false);
  assert.equal(state.executes.filter(sql => sql.includes('INSERT INTO schema_migrations')).length, 1);
});

test('dispatch unique-index migration rejects a partial or nonunique existing index', async () => {
  const state = fakeConnection({
    dispatchIndex: 'invalid',
    applied: DATABASE_MIGRATIONS.slice(0, 7).map(m => ({
      version: m.version, name: m.name, checksum: migrationChecksum(m),
    })),
  });
  await assert.rejects(() => runDatabaseMigrations(state.connection as never),
    /uniqueness index metadata mismatch/);
});


test('maintenance active admissions schema is additive and has no automatic OPEN lease', async () => {
  const state = fakeConnection({applied: DATABASE_MIGRATIONS.slice(0,8).map(m=>({version:m.version,name:m.name,checksum:migrationChecksum(m)}))});
  await runDatabaseMigrations(state.connection as never);
  const ddl=state.queries.find(sql=>sql.includes('CREATE TABLE IF NOT EXISTS maintenance_active_admissions'));
  assert.ok(ddl);
  assert.match(ddl,/FOREIGN KEY \(cluster_id\)/);
  assert.equal(state.queries.some(sql=>sql.includes('INSERT INTO maintenance_active_admissions')),false);
});
