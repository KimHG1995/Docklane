import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { BootstrapTokenRecord } from './bootstrap.types.js';
import { BootstrapService } from './bootstrap.service.js';

process.env.DOCKLANE_CLUSTER_ID = 'cluster-1';

test('bootstrap token is returned once while only its hash and TTL are persisted', async () => {
  let storedHash = '';
  let storedTtlSeconds = 0;
  const repository = {
    create: async (input: {
      id: string;
      tokenHash: string;
      clusterId: string;
      nodeRole: 'manager' | 'worker';
      labels: Record<string, string>;
      createdBy: string;
      ttlSeconds: number;
    }): Promise<BootstrapTokenRecord> => {
      storedHash = input.tokenHash;
      storedTtlSeconds = input.ttlSeconds;
      return {
        id: input.id,
        clusterId: input.clusterId,
        nodeRole: input.nodeRole,
        labels: input.labels,
        createdBy: input.createdBy,
        expiresAt: '2026-09-30T00:10:00.000Z',
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
    {} as never,
  );
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
  assert.equal(storedTtlSeconds, 600);
  assert.equal(issued.expiresAt, '2026-09-30T00:10:00.000Z');
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
    {} as never,
  );

  await assert.rejects(
    () =>
      service.issue(
        'cluster-1',
        {
          nodeRole: 'worker',
          labels: {},
          ttlSeconds: 600,
        },
        {
          actorId: 'admin-1',
          role: 'ADMIN',
          clusters: ['cluster-1'],
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
    labels: {},
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    claimId,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async () => record,
    bindCompletionNode: async () => 'BOUND' as const,
    recordCompletionAudit: async () => undefined,
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
    {} as never,
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
  assert.deepEqual(result.labels, {});
  assert.deepEqual(result.node.labels, {});
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
    bindCompletionNode: async () => 'BOUND' as const,
    recordCompletionAudit: async () => undefined,
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
    {} as never,
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


test('bootstrap completion applies scoped labels through node mutation coordinator', async () => {
  const claimId = '66666666-6666-4666-8666-666666666666';
  const record: BootstrapTokenRecord = {
    id: '66666666-6666-4666-8666-666666666667',
    clusterId: 'cluster-1',
    nodeRole: 'worker',
    labels: { zone: 'a', rack: 'r1' },
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    claimId,
    createdAt: new Date(0).toISOString(),
  };
  const repository = {
    findClaimableByHash: async () => record,
    bindCompletionNode: async () => 'BOUND' as const,
    recordCompletionAudit: async () => undefined,
  };

  let inspectCalls = 0;
  const agent = {
    inspectNode: async () => {
      inspectCalls += 1;
      return {
        node: {
          id: 'node-1',
          version: inspectCalls === 1 ? 7 : 8,
          specHash: inspectCalls === 1 ? 'before' : 'after',
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
          labels: inspectCalls === 1 ? {} : { zone: 'a', rack: 'r1' },
        },
        tasks: [],
        serviceIds: [],
      };
    },
  };

  let labelCalls = 0;
  const nodeMutations = {
    operation: async () => {
      throw new NotFoundException();
    },
    labels: async (
      clusterId: string,
      nodeId: string,
      input: {
        operationId: string;
        expectedVersion: number;
        set: Record<string, string>;
        remove: string[];
      },
      principal: { actorId: string },
    ) => {
      labelCalls += 1;
      assert.equal(clusterId, 'cluster-1');
      assert.equal(nodeId, 'node-1');
      assert.equal(input.operationId, record.id);
      assert.equal(input.expectedVersion, 7);
      assert.deepEqual(input.set, record.labels);
      assert.deepEqual(input.remove, []);
      assert.equal(principal.actorId, `bootstrap:${record.id}`);
      return { status: 'SUCCESS' };
    },
  };

  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
    nodeMutations as never,
  );

  const result = await service.complete({
    token: 'docklane_bootstrap_test_token_1234567890',
    claimId,
    nodeId: 'node-1',
  });

  assert.equal(labelCalls, 1);
  assert.equal(inspectCalls, 2);
  assert.deepEqual(result.node.labels, record.labels);
});

test('bootstrap label completion reuses persisted operation expectedVersion on retry', async () => {
  const claimId = '77777777-7777-4777-8777-777777777777';
  const record: BootstrapTokenRecord = {
    id: '77777777-7777-4777-8777-777777777778',
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
    bindCompletionNode: async () => 'BOUND' as const,
    recordCompletionAudit: async () => undefined,
  };
  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-1',
        version: 12,
        specHash: 'target',
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
        labels: { zone: 'a' },
      },
      tasks: [],
      serviceIds: [],
    }),
  };
  let expectedVersionSeen = -1;
  const nodeMutations = {
    operation: async () => ({
      id: record.id,
      expectedVersion: 7,
      status: 'SUCCESS',
    }),
    labels: async (
      _clusterId: string,
      _nodeId: string,
      input: { expectedVersion: number },
    ) => {
      expectedVersionSeen = input.expectedVersion;
      return { status: 'SUCCESS' };
    },
  };
  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
    nodeMutations as never,
  );

  await service.complete({
    token: 'docklane_bootstrap_test_token_1234567890',
    claimId,
    nodeId: 'node-1',
  });

  assert.equal(expectedVersionSeen, 7);
});

test('bootstrap completion rejects labels that are not observed after mutation', async () => {
  const claimId = '88888888-8888-4888-8888-888888888888';
  const record: BootstrapTokenRecord = {
    id: '88888888-8888-4888-8888-888888888889',
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
    bindCompletionNode: async () => 'BOUND' as const,
    recordCompletionAudit: async () => undefined,
  };
  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-1',
        version: 7,
        specHash: 'before',
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
  const nodeMutations = {
    operation: async () => {
      throw new NotFoundException();
    },
    labels: async () => ({ status: 'SUCCESS' }),
  };
  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
    nodeMutations as never,
  );

  await assert.rejects(
    () =>
      service.complete({
        token: 'docklane_bootstrap_test_token_1234567890',
        claimId,
        nodeId: 'node-1',
      }),
    /Joined node labels do not match bootstrap scope/,
  );
});


test('bootstrap issue rejects cluster outside configured Agent scope', async () => {
  let credentialCalls = 0;
  let createCalls = 0;
  const repository = {
    create: async () => {
      createCalls += 1;
      throw new Error('must not persist foreign-cluster bootstrap token');
    },
  };
  const swarmJoin = {
    credentials: () => {
      credentialCalls += 1;
      return {
        remoteAddr: '10.0.1.10:2377',
        joinToken: 'SWMTKN-1-worker-foreign-token-1234567890',
      };
    },
  };
  const service = new BootstrapService(
    repository as never,
    swarmJoin as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    () =>
      service.issue(
        'foreign-cluster',
        {
          nodeRole: 'worker',
          labels: {},
          ttlSeconds: 600,
        },
        {
          actorId: 'admin-1',
          role: 'ADMIN',
          clusters: ['foreign-cluster'],
        },
      ),
    /Cluster not found/,
  );

  assert.equal(credentialCalls, 0);
  assert.equal(createCalls, 0);
});

test('bootstrap completion rejects foreign cluster before Agent lookup', async () => {
  const claimId = '99999999-9999-4999-8999-999999999999';
  let inspectCalls = 0;
  const record: BootstrapTokenRecord = {
    id: 'foreign-token',
    clusterId: 'foreign-cluster',
    nodeRole: 'worker',
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
    inspectNode: async () => {
      inspectCalls += 1;
      throw new Error('must not inspect default Agent for foreign cluster');
    },
  };
  const service = new BootstrapService(
    repository as never,
    {} as never,
    agent as never,
    {} as never,
  );

  await assert.rejects(
    () =>
      service.complete({
        token: 'docklane_bootstrap_foreign_token_1234567890',
        claimId,
        nodeId: 'node-foreign',
      }),
    /Cluster not found/,
  );
  assert.equal(inspectCalls, 0);
});

test('bootstrap completion binds one canonical node and rejects a different retry node', async () => {
  const claimId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const record: BootstrapTokenRecord = {
    id: 'token-node-bound',
    clusterId: 'cluster-1',
    nodeRole: 'worker',
    labels: {},
    createdBy: 'admin-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: new Date().toISOString(),
    claimId,
    createdAt: new Date(0).toISOString(),
  };

  let boundNodeId: string | null = null;
  const repository = {
    findClaimableByHash: async () => record,
    bindCompletionNode: async (
      _tokenId: string,
      _claimId: string,
      nodeId: string,
    ) => {
      if (boundNodeId === null) {
        boundNodeId = nodeId;
        return 'BOUND' as const;
      }
      return boundNodeId === nodeId
        ? ('REPLAY' as const)
        : ('CONFLICT' as const);
    },
    recordCompletionAudit: async () => undefined,
  };

  const agent = {
    inspectNode: async (nodeId: string) => ({
      node: {
        id: nodeId,
        version: 1,
        specHash: 'node-spec',
        hostname: nodeId,
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
    {} as never,
  );

  const first = await service.complete({
    token: 'docklane_bootstrap_bound_token_1234567890',
    claimId,
    nodeId: 'node-a',
  });
  assert.equal(first.node.id, 'node-a');

  const replay = await service.complete({
    token: 'docklane_bootstrap_bound_token_1234567890',
    claimId,
    nodeId: 'node-a',
  });
  assert.equal(replay.node.id, 'node-a');

  await assert.rejects(
    () =>
      service.complete({
        token: 'docklane_bootstrap_bound_token_1234567890',
        claimId,
        nodeId: 'node-b',
      }),
    /already bound to a different node/,
  );
});
