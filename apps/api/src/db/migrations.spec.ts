import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE_MIGRATIONS,
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

test('database migrations apply the baseline once and skip it on replay', async () => {
  const state = fakeConnection();

  await runDatabaseMigrations(state.connection as never);
  assert.deepEqual(
    state.applied.map((row) => row.version),
    [1],
  );

  const insertsAfterFirst = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterFirst, 1);

  await runDatabaseMigrations(state.connection as never);

  const insertsAfterReplay = state.executes.filter((sql) =>
    sql.includes('INSERT INTO schema_migrations'),
  ).length;
  assert.equal(insertsAfterReplay, 1);
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

test('migration checksum is deterministic and catalog metadata is stable', () => {
  const migration = DATABASE_MIGRATIONS[0]!;
  const first = migrationChecksum(migration);
  const second = migrationChecksum(migration);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(migration.version, 1);
  assert.equal(migration.name, 'baseline-current-schema');
});
