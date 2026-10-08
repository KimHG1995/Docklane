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
    [1, 2, 3],
  );

  const insertsAfterFirst = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterFirst, 3);

  await runDatabaseMigrations(state.connection as never);

  const insertsAfterReplay = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterReplay, 3);
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
  assert.equal(state.executes.filter((sql) => sql.includes('INSERT INTO schema_migrations')).length, 1);
});
