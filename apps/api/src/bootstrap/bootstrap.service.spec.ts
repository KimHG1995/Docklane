import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import type { BootstrapTokenRecord } from './bootstrap.types.js';
import { BootstrapService } from './bootstrap.service.js';

test('bootstrap token is returned once while only its hash is persisted', async () => {
  let storedHash = '';
  let storedExpiresAtMs = 0;
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
      storedExpiresAtMs = input.expiresAt.getTime();
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

  const swarmJoin = {
    credentials: () => ({
      remoteAddr: '10.0.0.10:2377',
      joinToken: 'SWMTKN-1-worker-test-token-1234567890',
    }),
  };
  const service = new BootstrapService(
    repository as never,
    swarmJoin as never,
  );
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
  assert.ok(
    storedExpiresAtMs >= before + 599_000 &&
      storedExpiresAtMs <= before + 601_000,
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
    findValidByHash: async (): Promise<BootstrapTokenRecord | null> =>
      consumed ? null : { ...record, usedAt: null },
    consume: async (): Promise<BootstrapTokenRecord | null> => {
      if (consumed) return null;
      consumed = true;
      return record;
    },
  };
  const swarmJoin = {
    credentials: (_clusterId: string, role: 'manager' | 'worker') => ({
      remoteAddr: '10.0.0.10:2377',
      joinToken:
        role === 'manager'
          ? 'SWMTKN-1-manager-test-token-1234567890'
          : 'SWMTKN-1-worker-test-token-1234567890',
    }),
  };

  const service = new BootstrapService(
    repository as never,
    swarmJoin as never,
  );
  const claim = await service.claim({ token: 'docklane_bootstrap_test_token_1234567890' });

  assert.equal(claim.tokenId, 'token-1');
  assert.equal(claim.clusterId, 'cluster-1');
  assert.equal(claim.nodeRole, 'manager');
  assert.deepEqual(claim.labels, { rack: 'r1' });
  assert.deepEqual(claim.swarmJoin, {
    remoteAddr: '10.0.0.10:2377',
    joinToken: 'SWMTKN-1-manager-test-token-1234567890',
  });

  await assert.rejects(
    () => service.claim({ token: 'docklane_bootstrap_test_token_1234567890' }),
    UnauthorizedException,
  );
});


test('bootstrap issue fails before persistence when Swarm credentials are missing', async () => {
  let createCalls = 0;
  const repository = {
    create: async () => {
      createCalls += 1;
      throw new Error('must not persist without native join credentials');
    },
  };
  const swarmJoin = {
    credentials: () => null,
  };
  const service = new BootstrapService(
    repository as never,
    swarmJoin as never,
  );

  await assert.rejects(
    () =>
      service.issue(
        'cluster-missing',
        {
          nodeRole: 'worker',
          labels: {},
          ttlSeconds: 600,
        },
        {
          actorId: 'admin-1',
          role: 'ADMIN',
          clusters: ['cluster-missing'],
        },
      ),
    /Swarm join credentials are not configured/,
  );
  assert.equal(createCalls, 0);
});

test('bootstrap claim does not consume token when native credentials are unavailable', async () => {
  let consumeCalls = 0;
  const pending: BootstrapTokenRecord = {
    id: 'token-pending',
    clusterId: 'cluster-1',
    nodeRole: 'worker',
    labels: {},
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: null,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findValidByHash: async () => pending,
    consume: async () => {
      consumeCalls += 1;
      return null;
    },
  };
  const swarmJoin = {
    credentials: () => null,
  };
  const service = new BootstrapService(
    repository as never,
    swarmJoin as never,
  );

  await assert.rejects(
    () =>
      service.claim({
        token: 'docklane_bootstrap_test_token_1234567890',
      }),
    /Swarm join credentials are not configured/,
  );
  assert.equal(consumeCalls, 0);
});
