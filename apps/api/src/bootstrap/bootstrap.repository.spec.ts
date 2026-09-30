import test from 'node:test';
import assert from 'node:assert/strict';
import { BootstrapRepository } from './bootstrap.repository.js';

type BootstrapRow = {
  id: string;
  token_hash: string;
  cluster_id: string;
  node_role: 'manager' | 'worker';
  labels_json: string;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  claim_id: string | null;
  created_at: Date;
};

function fakeDb(initial?: Partial<BootstrapRow>) {
  const row: BootstrapRow = {
    id: '11111111-1111-4111-8111-111111111111',
    token_hash: 'a'.repeat(64),
    cluster_id: 'cluster-1',
    node_role: 'worker',
    labels_json: JSON.stringify({ zone: 'a' }),
    created_by: 'admin-1',
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
    claim_id: null,
    created_at: new Date(0),
    ...initial,
  };

  const executedSql: string[] = [];
  const queriedSql: string[] = [];

  const auditRows: Array<{
    operationId: string;
    actorId: string;
    clusterId: string;
    serviceId: string;
    resourceType: string;
    resourceId: string;
    action: string;
    afterJson: string;
  }> = [];

  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      queriedSql.push(sql);
      if (sql.includes('FROM bootstrap_tokens')) {
        return [[{ ...row }], []];
      }
      if (
        sql.includes('FROM audit_events') &&
        sql.includes('operation_id = ?') &&
        sql.includes('action = ?')
      ) {
        const [operationId, action] = params as [string, string];
        const found = auditRows.find(
          (audit) =>
            audit.operationId === operationId &&
            audit.action === action,
        );
        return [found ? [{ id: 1 }] : [], []];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executedSql.push(sql);
      if (sql.includes('INSERT INTO bootstrap_tokens')) {
        const [
          id,
          tokenHash,
          clusterId,
          nodeRole,
          labelsJson,
          createdBy,
          ttlSeconds,
        ] = params as [
          string,
          string,
          string,
          'manager' | 'worker',
          string,
          string,
          number,
        ];
        row.id = id;
        row.token_hash = tokenHash;
        row.cluster_id = clusterId;
        row.node_role = nodeRole;
        row.labels_json = labelsJson;
        row.created_by = createdBy;
        row.expires_at = new Date(Date.now() + ttlSeconds * 1000);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SET used_at = UTC_TIMESTAMP')) {
        const [claimId] = params as [string, string];
        row.claim_id = claimId;
        row.used_at = new Date('2026-09-30T00:00:00.000Z');
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('INSERT INTO audit_events')) {
        const [
          operationId,
          actorId,
          clusterId,
          serviceId,
          resourceId,
          action,
          afterJson,
        ] = params as [string, string, string, string, string, string, string];
        auditRows.push({
          operationId,
          actorId,
          clusterId,
          serviceId,
          resourceType: 'bootstrap_token',
          resourceId,
          action,
          afterJson,
        });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
  };

  return {
    row,
    auditRows,
    executedSql,
    queriedSql,
    db: {
      getConnection: async () => connection,
      pool: {
        query: async () => [[], []],
      },
    },
  };
}

test('bootstrap issue audit stores scope without credential secrets', async () => {
  const state = fakeDb();
  const repository = new BootstrapRepository(state.db as never);

  await repository.create({
    id: state.row.id,
    tokenHash: 'b'.repeat(64),
    clusterId: 'cluster-1',
    nodeRole: 'worker',
    labels: { zone: 'a' },
    createdBy: 'admin-1',
    ttlSeconds: 600,
  });

  assert.ok(
    state.executedSql.some(
      (sql) =>
        sql.includes('DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)'),
    ),
  );
  assert.equal(state.auditRows.length, 1);
  const audit = state.auditRows[0]!;
  assert.equal(audit.action, 'BOOTSTRAP_TOKEN_ISSUED');
  assert.equal(audit.actorId, 'admin-1');
  assert.equal(audit.resourceType, 'bootstrap_token');

  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes('docklane_bootstrap_'), false);
  assert.equal(serialized.includes('SWMTKN-'), false);
  assert.deepEqual(JSON.parse(audit.afterJson), {
    nodeRole: 'worker',
    labels: { zone: 'a' },
    expiresAt: state.row.expires_at.toISOString(),
  });
});

test('bootstrap claim replay records one audit event', async () => {
  const state = fakeDb();
  const repository = new BootstrapRepository(state.db as never);
  const claimId = '22222222-2222-4222-8222-222222222222';

  const first = await repository.consume(state.row.token_hash, claimId);
  const replay = await repository.consume(state.row.token_hash, claimId);

  assert.equal(first?.replayed, false);
  assert.equal(replay?.replayed, true);
  assert.equal(
    state.auditRows.filter(
      (audit) => audit.action === 'BOOTSTRAP_TOKEN_CLAIMED',
    ).length,
    1,
  );

  const audit = state.auditRows.find(
    (entry) => entry.action === 'BOOTSTRAP_TOKEN_CLAIMED',
  )!;
  assert.equal(audit.actorId, `bootstrap:${state.row.id}`);
  assert.equal(audit.afterJson.includes('SWMTKN-'), false);
  assert.equal(audit.afterJson.includes('docklane_bootstrap_'), false);
});

test('bootstrap completion audit is exactly once for retries', async () => {
  const claimId = '33333333-3333-4333-8333-333333333333';
  const state = fakeDb({
    used_at: new Date('2026-09-30T00:00:00.000Z'),
    claim_id: claimId,
  });
  const repository = new BootstrapRepository(state.db as never);
  const record = {
    id: state.row.id,
    clusterId: state.row.cluster_id,
    nodeRole: state.row.node_role,
    labels: { zone: 'a' },
    createdBy: state.row.created_by,
    expiresAt: state.row.expires_at.toISOString(),
    usedAt: state.row.used_at!.toISOString(),
    claimId,
    createdAt: state.row.created_at.toISOString(),
  };

  const completion = {
    nodeId: 'node-1',
    hostname: 'worker-01',
    role: 'worker',
    labels: { zone: 'a' },
    verifiedAt: '2026-09-30T00:01:00.000Z',
  };

  await repository.recordCompletionAudit(record, completion);
  await repository.recordCompletionAudit(record, completion);

  const audits = state.auditRows.filter(
    (audit) => audit.action === 'BOOTSTRAP_COMPLETED',
  );
  assert.equal(audits.length, 1);
  assert.deepEqual(JSON.parse(audits[0]!.afterJson), {
    claimId,
    ...completion,
  });
});


test('bootstrap claimability and consume use UTC database clock', async () => {
  const state = fakeDb();
  const repository = new BootstrapRepository(state.db as never);
  const claimId = '44444444-4444-4444-8444-444444444444';

  const claimable = await repository.findClaimableByHash(
    state.row.token_hash,
    claimId,
  );
  assert.ok(claimable);
  assert.ok(
    state.queriedSql.some((sql) =>
      sql.includes('expires_at > UTC_TIMESTAMP(6)'),
    ),
  );

  await repository.consume(state.row.token_hash, claimId);
  assert.ok(
    state.executedSql.some((sql) =>
      sql.includes('SET used_at = UTC_TIMESTAMP(6)'),
    ),
  );
  assert.ok(
    state.queriedSql.some((sql) =>
      sql.includes('expires_at > UTC_TIMESTAMP(6)'),
    ),
  );
});
