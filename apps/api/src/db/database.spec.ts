import assert from 'node:assert/strict';
import test from 'node:test';
import type { RowDataPacket } from 'mysql2/promise';
import { Database } from './database.js';

test('standalone query initializes the MySQL session to UTC and releases it', async () => {
  const calls: string[] = [];
  const connection = {
    query: async (sql: string) => {
      calls.push(sql);
      return sql.startsWith('SET time_zone')
        ? [[], []]
        : [[{ value: 1 }], []];
    },
    release: () => calls.push('release'),
  };

  const database = Object.create(Database.prototype) as Database;
  Object.defineProperty(database, 'pool', {
    value: {
      getConnection: async () => connection,
    },
  });

  const [rows] = await database.query<Array<RowDataPacket & { value: number }>>(
    'SELECT 1 AS value',
  );

  assert.equal(rows[0]?.value, 1);
  assert.deepEqual(calls, [
    "SET time_zone = '+00:00'",
    'SELECT 1 AS value',
    'release',
  ]);
});

test('standalone query releases the UTC-initialized connection on query failure', async () => {
  const calls: string[] = [];
  const connection = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SET time_zone')) {
        return [[], []];
      }
      throw new Error('query failed');
    },
    release: () => calls.push('release'),
  };

  const database = Object.create(Database.prototype) as Database;
  Object.defineProperty(database, 'pool', {
    value: {
      getConnection: async () => connection,
    },
  });

  await assert.rejects(
    database.query<RowDataPacket[]>('SELECT broken'),
    /query failed/,
  );
  assert.deepEqual(calls, [
    "SET time_zone = '+00:00'",
    'SELECT broken',
    'release',
  ]);
});
