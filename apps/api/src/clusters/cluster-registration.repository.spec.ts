import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../db/database.js';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';

const input = { clusterId: 'default', swarmClusterId: 'swarm-a', displayName: '운영',
  registeredBy: 'admin-a', verifiedNodeId: 'node-a' };
const duplicate = () => Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });

type Row = { id: string; cluster_id: string; swarm_cluster_id: string; display_name: string;
  registered_by: string; verified_node_id: string; created_at: Date };

// Execute the real repository; only the database/connection is replaced.
function fixture() {
  const state = { row: null as Row | null, audit: [] as unknown[][], calls: [] as string[],
    insertError: null as Error | null, auditError: null as Error | null,
    commitError: null as Error | null, queryError: null as Error | null,
    missingInserted: false, lostCommitResponse: false, released: 0 };
  let saved: { row: Row | null; audit: unknown[][] } | null = null;
  const connection = {
    async beginTransaction() { state.calls.push('begin'); saved = structuredClone({ row: state.row, audit: state.audit }); },
    async commit() {
      state.calls.push('commit');
      if (state.commitError) throw state.commitError;
      saved = null;
      if (state.lostCommitResponse) throw new Error('commit response lost');
    },
    async rollback() {
      state.calls.push('rollback');
      if (saved) { state.row = saved.row; state.audit = saved.audit; saved = null; }
    },
    release() { state.released++; },
    async query(sql: string, params: unknown[]) {
      state.calls.push('select');
      assert.ok(sql.includes('FROM cluster_registrations'));
      assert.equal(params.length, 1);
      if (state.queryError) throw state.queryError;
      return [state.row && state.row.cluster_id === params[0] && !state.missingInserted ? [structuredClone(state.row)] : [], []];
    },
    async execute(sql: string, params: unknown[]) {
      if (sql.includes('INSERT INTO cluster_registrations')) {
        state.calls.push('insert');
        if (state.insertError) throw state.insertError;
        if (state.row) throw duplicate();
        const [id, clusterId, swarmId, name, actor, node] = params as string[];
        state.row = { id: id!, cluster_id: clusterId!, swarm_cluster_id: swarmId!, display_name: name!,
          registered_by: actor!, verified_node_id: node!, created_at: new Date('2026-10-08T00:00:00.000Z') };
      } else {
        assert.ok(sql.includes('INSERT INTO audit_events'));
        assert.ok(sql.includes("'cluster'"));
        assert.ok(sql.includes("'CLUSTER_REGISTERED'"));
        state.calls.push('audit');
        if (state.auditError) throw state.auditError;
        state.audit.push(structuredClone(params));
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  const db = { async getConnection() { return connection; }, query: connection.query } as unknown as Database;
  return { state, repository: new ClusterRegistrationRepository(db), create: () => new ClusterRegistrationRepository(db) };
}

test('cluster registration and sanitized audit commit atomically with UTC timestamp', async () => {
  const f = fixture();
  const row = await f.repository.register(input);
  assert.deepEqual(f.state.calls, ['begin', 'insert', 'select', 'audit', 'commit']);
  assert.equal(row.createdAt, '2026-10-08T00:00:00.000Z');
  assert.equal(row.registeredBy, input.registeredBy);
  assert.equal(f.state.audit.length, 1);
  assert.ok(JSON.stringify(f.state.audit).includes(row.id));
  assert.ok(JSON.stringify(f.state.audit).includes('swarm-a'));
  assert.equal(f.state.released, 1);
});

test('same mapping after insert duplicate returns the committed record without another audit', async () => {
  const f = fixture();
  const first = await f.repository.register(input);
  const second = await f.repository.register({ ...input, registeredBy: 'admin-b', verifiedNodeId: 'node-b' });
  assert.deepEqual(second, first);
  assert.equal(f.state.audit.length, 1);
  assert.deepEqual(f.state.calls.slice(-4), ['begin', 'insert', 'rollback', 'select']);
  assert.equal(f.state.released, 2);
});

test('conflicting duplicate aliases, names and actual Swarm IDs are never overwritten', async () => {
  for (const change of [{ swarmClusterId: 'swarm-b' }, { displayName: 'other' }, { clusterId: 'other' }]) {
    const f = fixture();
    const first = await f.repository.register(input);
    await assert.rejects(f.repository.register({ ...input, ...change }), /already registered/);
    assert.equal(f.state.row?.id, first.id);
    assert.equal(f.state.audit.length, 1);
  }
});

test('audit failure rolls back the registration and allows a clean new attempt', async () => {
  const f = fixture();
  f.state.auditError = new Error('audit insert rejected');
  await assert.rejects(f.repository.register(input), /audit insert rejected/);
  assert.equal(f.state.row, null);
  assert.equal(f.state.audit.length, 0);
  assert.equal(f.state.released, 1);
  f.state.auditError = null;
  await f.repository.register(input);
  assert.equal(f.state.audit.length, 1);
});

test('duplicate-looking audit failure is not confused with a duplicate registration', async () => {
  const f = fixture();
  f.state.auditError = duplicate();
  await assert.rejects(f.repository.register(input), /duplicate/);
  assert.equal(f.state.row, null);
  assert.deepEqual(f.state.calls, ['begin', 'insert', 'select', 'audit', 'rollback']);
});

test('ordinary connection, insert and commit failures are not retried or reported as success', async () => {
  for (const kind of ['insertError', 'queryError', 'commitError'] as const) {
    const f = fixture();
    f.state[kind] = new Error('database unavailable');
    await assert.rejects(f.repository.register(input), /database unavailable/);
    assert.equal(f.state.calls.filter((call) => call === 'insert').length, 1);
    assert.equal(f.state.row, null);
    assert.equal(f.state.audit.length, 0);
    assert.equal(f.state.released, 1);
  }
});

test('missing inserted row cannot be committed as a registration', async () => {
  const f = fixture();
  f.state.missingInserted = true;
  await assert.rejects(f.repository.register(input), /disappeared/);
  assert.equal(f.state.row, null);
  assert.equal(f.state.audit.length, 0);
});

test('a new repository instance reads only stored registration without a new write', async () => {
  const f = fixture();
  const first = await f.repository.register(input);
  const row = await f.create().find(input.clusterId);
  assert.deepEqual(row, first);
  assert.equal(f.state.calls.filter((c) => c === 'insert').length, 1);
});


test('lost commit response remains an error but explicit replay reads the committed result once', async () => {
  const f = fixture();
  f.state.lostCommitResponse = true;
  await assert.rejects(f.repository.register(input), /commit response lost/);
  assert.equal(f.state.audit.length, 1);
  assert.equal(f.state.calls.filter((c) => c === 'insert').length, 1, 'no automatic resend');
  const storedId = f.state.row?.id;
  f.state.lostCommitResponse = false;
  const replay = await f.create().register(input);
  assert.equal(replay.id, storedId);
  assert.equal(f.state.audit.length, 1);
});
