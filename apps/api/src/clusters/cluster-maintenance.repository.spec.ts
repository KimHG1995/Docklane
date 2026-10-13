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
