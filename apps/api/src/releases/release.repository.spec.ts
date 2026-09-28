import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseRepository } from './release.repository.js';

function applicationRow(id: string) {
  return {
    id,
    name: 'api',
    description: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

test('application create and audit share one transaction', async () => {
  const calls: string[] = [];
  let insertedId = '';

  const connection = {
    beginTransaction: async () => calls.push('begin'),
    execute: async (_sql: string, params: unknown[]) => {
      insertedId = String(params[0]);
      calls.push('insert');
      return [{}, []];
    },
    query: async () => [[applicationRow(insertedId)], []],
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
  };
  const db = {
    getConnection: async () => connection,
  };
  const audit = {
    record: async (receivedConnection: unknown) => {
      assert.equal(receivedConnection, connection);
      calls.push('audit');
    },
  };

  const repository = new ReleaseRepository(db as never, audit as never);
  const created = await repository.createApplication(
    { name: 'api' },
    'operator-1',
  );

  assert.equal(created.name, 'api');
  assert.deepEqual(calls, ['begin', 'insert', 'audit', 'commit', 'release']);
});

test('audit failure rolls back the release-domain insert', async () => {
  const calls: string[] = [];
  let insertedId = '';

  const connection = {
    beginTransaction: async () => calls.push('begin'),
    execute: async (_sql: string, params: unknown[]) => {
      insertedId = String(params[0]);
      calls.push('insert');
      return [{}, []];
    },
    query: async () => [[applicationRow(insertedId)], []],
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
  };
  const db = {
    getConnection: async () => connection,
  };
  const audit = {
    record: async () => {
      calls.push('audit');
      throw new Error('audit unavailable');
    },
  };

  const repository = new ReleaseRepository(db as never, audit as never);

  await assert.rejects(
    repository.createApplication({ name: 'api' }, 'operator-1'),
    /audit unavailable/,
  );

  assert.deepEqual(calls, ['begin', 'insert', 'audit', 'rollback', 'release']);
});
