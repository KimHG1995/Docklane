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
        claimId: null,
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
    {} as never,
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

test('bootstrap claim replays only for the same claimId', async () => {
  const claimId = '11111111-1111-4111-8111-111111111111';
  let claimed = false;
  const claimedAt = new Date().toISOString();
  const base: BootstrapTokenRecord = {
    id: 'token-1',
    clusterId: 'cluster-1',
    nodeRole: 'manager',
    labels: { rack: 'r1' },
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: null,
    claimId: null,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async (
      _hash: string,
      requestedClaimId: string,
    ): Promise<BootstrapTokenRecord | null> => {
      if (!claimed) return base;
      return requestedClaimId === claimId
        ? { ...base, usedAt: claimedAt, claimId }
        : null;
    },
    consume: async (
      _hash: string,
      requestedClaimId: string,
    ): Promise<{ record: BootstrapTokenRecord; replayed: boolean } | null> => {
      if (claimed && requestedClaimId !== claimId) return null;
      const replayed = claimed;
      claimed = true;
      return {
        record: {
          ...base,
          usedAt: claimedAt,
          claimId,
        },
        replayed,
      };
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
    {} as never,
  );
  const request = {
    token: 'docklane_bootstrap_test_token_1234567890',
    claimId,
  };

  const first = await service.claim(request);
  assert.equal(first.claimId, claimId);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.swarmJoin, {
    remoteAddr: '10.0.0.10:2377',
    joinToken: 'SWMTKN-1-manager-test-token-1234567890',
  });

  const replay = await service.claim(request);
  assert.equal(replay.claimId, claimId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.claimedAt, first.claimedAt);

  await assert.rejects(
    () =>
      service.claim({
        token: request.token,
        claimId: '22222222-2222-4222-8222-222222222222',
      }),
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
    {} as never,
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
    claimId: null,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async () => pending,
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
    {} as never,
  );

  await assert.rejects(
    () =>
      service.claim({
        token: 'docklane_bootstrap_test_token_1234567890',
        claimId: '33333333-3333-4333-8333-333333333333',
      }),
    /Swarm join credentials are not configured/,
  );
  assert.equal(consumeCalls, 0);
});


test('bootstrap completion verifies joined node role through Agent', async () => {
  const claimId = '44444444-4444-4444-8444-444444444444';
  const record: BootstrapTokenRecord = {
    id: 'token-complete',
    clusterId: 'cluster-1',
    nodeRole: 'worker',
    labels: { zone: 'a' },
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    claimId,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async () => record,
  };
  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-1',
        version: 1,
        specHash: 'node-spec',
        hostname: 'worker-01',
        address: '10.0.0.21',
        role: 'worker',
        availability: 'active',
        state: 'ready',
        manager: false,
        leader: false,
        engineVersion: '28.5.1',
        nanoCpus: 2_000_000_000,
        memoryBytes: 4_000_000_000,
        labels: {},
      },
      tasks: [],
      serviceIds: [],
    }),
  };
  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
  );

  const result = await service.complete({
    token: 'docklane_bootstrap_test_token_1234567890',
    claimId,
    nodeId: 'node-1',
  });

  assert.equal(result.node.id, 'node-1');
  assert.equal(result.node.role, 'worker');
  assert.equal(result.node.state, 'ready');
  assert.equal(result.nodeRole, 'worker');
  assert.deepEqual(result.labels, { zone: 'a' });
});

test('bootstrap completion rejects node role mismatch', async () => {
  const claimId = '55555555-5555-4555-8555-555555555555';
  const record: BootstrapTokenRecord = {
    id: 'token-role-mismatch',
    clusterId: 'cluster-1',
    nodeRole: 'manager',
    labels: {},
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    claimId,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async () => record,
  };
  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-worker',
        hostname: 'worker-02',
        role: 'worker',
        availability: 'active',
        state: 'ready',
        manager: false,
      },
    }),
  };
  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
  );

  await assert.rejects(
    () =>
      service.complete({
        token: 'docklane_bootstrap_test_token_1234567890',
        claimId,
        nodeId: 'node-worker',
      }),
    /Joined node state or role does not match bootstrap scope/,
  );
});
