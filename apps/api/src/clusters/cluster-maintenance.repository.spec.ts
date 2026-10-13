import assert from 'node:assert/strict';
import test from 'node:test';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';

function repository(rows: unknown[], fail = false) {
  const database = {
    query: async () => {
      if (fail) throw new Error('DB unavailable');
      return [rows];
    },
  };
  return new ClusterMaintenanceRepository(database as never);
}

const open = {
  cluster_id: 'default',
  state: 'OPEN',
  generation: '1',
  owner_id: 'operator',
  reason: 'initialized',
  changed_by: 'admin',
  changed_at: new Date('2026-10-13T00:00:00Z'),
};

test('maintenance read returns valid OPEN with lossless generation', async () => {
  const row = await repository([{ ...open, generation: '9007199254740993' }]).requireOpen('default');
  assert.equal(row.generation, 9007199254740993n);
  assert.equal(row.state, 'OPEN');
});

test('missing maintenance row fails closed instead of assuming OPEN', async () => {
  await assert.rejects(() => repository([]).requireOpen('default'), /missing or invalid/);
});

test('database error fails closed', async () => {
  await assert.rejects(() => repository([], true).requireOpen('default'), /cannot be verified/);
});

for (const state of ['CLOSING', 'CLOSED', 'RECONCILING']) {
  test(`maintenance state ${state} blocks mutation`, async () => {
    await assert.rejects(() => repository([{ ...open, state }]).requireOpen('default'), /mutation is blocked/);
  });
}

test('unknown state and zero generation do not grant admission', async () => {
  await assert.rejects(() => repository([{ ...open, state: 'UNKNOWN' }]).requireOpen('default'), /missing or invalid/);
  await assert.rejects(() => repository([{ ...open, generation: '0' }]).requireOpen('default'), /generation is invalid/);
});

test('maintenance transition requires valid next state and generation', async () => {
  const repository = repositoryForTransitions();
  await assert.rejects(
    () => repository.compareAndSetState('default', 'OPEN', 1n, 'CLOSED', 'admin', 'maintenance'),
    /Invalid maintenance state transition/,
  );
  await assert.rejects(
    () => repository.compareAndSetState('default', 'OPEN', 0n, 'CLOSING', 'admin', 'maintenance'),
    /Invalid maintenance state transition/,
  );
});

function repositoryForTransitions(affectedRows = 1) {
  const db = { query: async () => [{ affectedRows }] };
  return new ClusterMaintenanceRepository(db as never);
}

test('maintenance generation CAS uses expected state and avoids stale takeover', async () => {
  const calls: unknown[][] = [];
  const repo = new ClusterMaintenanceRepository({
    query: async (_sql: string, args: unknown[]) => {
      calls.push(args);
      return [{ affectedRows: calls.length === 1 ? 1 : 0 }];
    },
  } as never);
  assert.equal(await repo.compareAndSetState('default', 'OPEN', 2n, 'CLOSING', 'admin', 'scheduled maintenance'), true);
  assert.equal(await repo.compareAndSetState('default', 'OPEN', 2n, 'CLOSING', 'admin', 'scheduled maintenance'), false);
  assert.equal(calls[0]?.at(-1), '2');
});

test('initialization requires an actor and reason', async () => {
  const repo = repositoryForTransitions();
  await assert.rejects(() => repo.initializeOpen('default', '', 'maintenance'), /requires actor/);
  await assert.rejects(() => repo.initializeOpen('default', 'admin', ''), /requires actor/);
});

test('generation query casts BIGINT before mysql2 can round it', async () => {
  let sql = '';
  const repo = new ClusterMaintenanceRepository({
    query: async (statement: string) => {
      sql = statement;
      return [[{
        cluster_id: 'default', state: 'OPEN',
        generation: '9007199254740993', owner_id: '관리자',
        reason: 'maintenance', changed_by: '관리자',
        changed_at: new Date('2026-10-13T00:00:00Z'),
      }]];
    },
  } as never);
  const result = await repo.requireRecord('default');
  assert.match(sql, /CAST\(generation AS CHAR\) AS generation/);
  assert.equal(result.generation, 9007199254740993n);
  assert.equal(result.ownerId, '관리자');
});

test('unresolved operation count includes service and node attention states', async () => {
  let query = '';
  const repo = new ClusterMaintenanceRepository({
    query: async (sql: string) => { query = sql; return [[{ count: '9007199254740993' }]]; },
  } as never);
  assert.equal(await repo.countUnresolvedOperations('default'), 9007199254740993n);
  assert.match(query, /FROM operations/);
  assert.match(query, /FROM node_operations/);
  assert.match(query, /NEEDS_ATTENTION/);
});
test('missing unresolved operation evidence fails closed', async () => {
  const repo = new ClusterMaintenanceRepository({
    query: async () => [[]],
  } as never);
  await assert.rejects(() => repo.countUnresolvedOperations('default'), /cannot be verified/);
});
