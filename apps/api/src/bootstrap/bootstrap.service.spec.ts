import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { BootstrapTokenRecord } from './bootstrap.types.js';
import { BootstrapService } from './bootstrap.service.js';

test('bootstrap token is returned once while only its hash is persisted', async () => {
  let storedHash = '';
  let storedExpiresAt: Date | null = null;
  const repository = {
    create: async (input: {
      id: string;
      tokenHash: string;
      clusterId: string;
      nodeRole: 'manager' | 'worker';
      labels: Record<string, string>;
      createdBy: string;
      expiresAt: Date;
    }): Promise<BootstrapTokenRecord> => {
      storedHash = input.tokenHash;
      storedExpiresAt = input.expiresAt;
      return {
        id: input.id,
        clusterId: input.clusterId,
        nodeRole: input.nodeRole,
        labels: input.labels,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt.toISOString(),
        usedAt: null,
        createdAt: new Date(0).toISOString(),
      };
    },
  };

  const service = new BootstrapService(repository as never);
  const before = Date.now();
  const issued = await service.issue(
    'cluster-1',
    {
      nodeRole: 'worker',
      labels: { zone: 'a' },
      ttlSeconds: 600,
    },
    {
      actorId: 'admin-1',
      role: 'ADMIN',
      clusters: ['cluster-1'],
    },
  );

  assert.match(issued.token, /^docklane_bootstrap_[A-Za-z0-9_-]+$/);
  assert.equal(storedHash.length, 64);
  assert.equal(storedHash.includes(issued.token), false);
  assert.equal(issued.clusterId, 'cluster-1');
  assert.equal(issued.nodeRole, 'worker');
  assert.deepEqual(issued.labels, { zone: 'a' });
  assert.ok(storedExpiresAt);
  assert.ok(
    storedExpiresAt!.getTime() >= before + 599_000 &&
      storedExpiresAt!.getTime() <= before + 601_000,
  );
});

test('bootstrap token claim is one-time', async () => {
  let consumed = false;
  const record: BootstrapTokenRecord = {
    id: 'token-1',
    clusterId: 'cluster-1',
    nodeRole: 'manager',
    labels: { rack: 'r1' },
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    consume: async (): Promise<BootstrapTokenRecord | null> => {
      if (consumed) return null;
      consumed = true;
      return record;
    },
  };

  const service = new BootstrapService(repository as never);
  const claim = await service.claim({ token: 'docklane_bootstrap_test_token_1234567890' });

  assert.equal(claim.tokenId, 'token-1');
  assert.equal(claim.clusterId, 'cluster-1');
  assert.equal(claim.nodeRole, 'manager');
  assert.deepEqual(claim.labels, { rack: 'r1' });

  await assert.rejects(
    () => service.claim({ token: 'docklane_bootstrap_test_token_1234567890' }),
    UnauthorizedException,
  );
});
