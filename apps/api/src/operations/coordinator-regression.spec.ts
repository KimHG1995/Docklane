import test from 'node:test';
import assert from 'node:assert/strict';
import { MutationService } from './mutation.service.js';
import { NodeMutationService } from './node-mutation.service.js';
import type { NodeOperationRecord, OperationRecord } from './operation.types.js';

const principal = {
  actorId: 'tester',
  role: 'OPERATOR' as const,
  clusters: ['default'],
};

function serviceDetail() {
  return {
    service: {
      id: 'service-1',
      name: 'api',
      version: 10,
      specHash: 'service-spec',
      forceUpdate: 0,
      mode: 'replicated',
      desiredReplicas: 1,
      runningReplicas: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    tasks: [],
  };
}

const unresolvedNodeOperation: NodeOperationRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  clusterId: 'default',
  nodeId: 'node-1',
  type: 'DRAIN',
  status: 'NEEDS_ATTENTION',
  actorId: 'tester',
  expectedVersion: 5,
  beforeSpecHash: 'node-before',
  targetSpecHash: 'node-drain',
  targetAvailability: 'drain',
  affectedServiceIds: ['service-1'],
  targetLabels: null,
  labelPatch: null,
  resultVersion: 6,
  errorCode: 'NODE_VERIFICATION_UNCERTAIN',
  errorMessage: 'pending',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

test('scale is blocked by an unresolved node operation affecting the service', async () => {
  let planned = false;
  let mutated = false;

  const agent = {
    inspectService: async () => serviceDetail(),
    planScaleService: async () => {
      planned = true;
      throw new Error('must not plan');
    },
    scaleService: async () => {
      mutated = true;
      throw new Error('must not mutate');
    },
  };

  const connection = {};
  const operations = {
    listNonTerminal: async () => [],
    findWithConnection: async () => null,
    findNonTerminalForServiceWithConnection: async () => null,
  };
  const nodeOperations = {
    findNonTerminalAffectingServiceWithConnection: async () =>
      unresolvedNodeOperation,
  };
  const lock = {
    withServiceLock: async (
      _clusterId: string,
      _serviceId: string,
      fn: (connection: unknown) => Promise<unknown>,
    ) => fn(connection),
  };

  const capacity = {
    assertAvailable: async () => ({ status: 'SUFFICIENT' }),
  };

  const service = new MutationService(
    agent as never,
    operations as never,
    nodeOperations as never,
    lock as never,
    capacity as never,
  );

  await assert.rejects(
    service.scale(
      'default',
      'service-1',
      {
        operationId: '00000000-0000-4000-8000-000000000002',
        expectedVersion: 10,
        replicas: 2,
      },
      principal,
    ),
    /unresolved node operation/,
  );

  assert.equal(planned, false);
  assert.equal(mutated, false);
});

test('node retry locks stored affected services after tasks have moved away', async () => {
  let capturedServiceIds: string[] = [];

  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-1',
        version: 6,
        specHash: 'node-drain',
        hostname: 'worker-1',
        address: '10.0.0.1',
        role: 'worker',
        availability: 'drain',
        state: 'ready',
        manager: false,
        leader: false,
        nanoCpus: 1,
        memoryBytes: 1,
        labels: {},
      },
      tasks: [],
      serviceIds: [],
    }),
  };
  const nodeOperations = {
    listNonTerminal: async () => [],
    find: async () => unresolvedNodeOperation,
    findNonTerminalForNode: async () => unresolvedNodeOperation,
  };
  const serviceOperations = {};
  const sentinel = new Error('captured-lock-set');
  const lock = {
    withNodeAndServiceLocks: async (
      _clusterId: string,
      _nodeId: string,
      serviceIds: string[],
    ) => {
      capturedServiceIds = [...serviceIds];
      throw sentinel;
    },
  };

  const service = new NodeMutationService(
    agent as never,
    nodeOperations as never,
    serviceOperations as never,
    lock as never,
  );

  await assert.rejects(
    service.drain(
      'default',
      'node-1',
      {
        operationId: unresolvedNodeOperation.id,
        expectedVersion: 5,
      },
      principal,
    ),
    sentinel,
  );

  assert.deepEqual(capturedServiceIds, ['service-1']);
});


test('node label mutation is blocked by another unresolved node operation affecting the same service', async () => {
  let planned = false;

  const crossNodeOperation: NodeOperationRecord = {
    ...unresolvedNodeOperation,
    id: '00000000-0000-4000-8000-000000000020',
    nodeId: 'node-a',
  };

  const agent = {
    inspectNode: async () => ({
      node: {
        id: 'node-b',
        version: 5,
        specHash: 'node-before',
        hostname: 'worker-b',
        address: '10.0.0.2',
        role: 'worker',
        availability: 'active',
        state: 'ready',
        manager: false,
        leader: false,
        nanoCpus: 1,
        memoryBytes: 1,
        labels: {},
      },
      tasks: [],
      serviceIds: [],
    }),
    listServices: async () => [{ id: 'service-1' }],
    planNodeLabels: async () => {
      planned = true;
      throw new Error('must not plan');
    },
  };

  const connection = {};
  const nodeOperations = {
    listNonTerminal: async () => [],
    find: async () => null,
    findNonTerminalForNode: async () => null,
    findWithConnection: async () => null,
    findNonTerminalForNodeWithConnection: async () => null,
    findNonTerminalAffectingServiceWithConnection: async () =>
      crossNodeOperation,
  };
  const serviceOperations = {
    findNonTerminalForServiceWithConnection: async () => null,
  };
  const lock = {
    withNodeAndServiceLocks: async (
      _clusterId: string,
      _nodeId: string,
      _serviceIds: string[],
      fn: (connection: unknown) => Promise<unknown>,
    ) => fn(connection),
  };

  const service = new NodeMutationService(
    agent as never,
    nodeOperations as never,
    serviceOperations as never,
    lock as never,
  );

  await assert.rejects(
    service.labels(
      'default',
      'node-b',
      {
        operationId: '00000000-0000-4000-8000-000000000021',
        expectedVersion: 5,
        set: { zone: 'b' },
        remove: [],
      },
      principal,
    ),
    /unresolved node operation/,
  );

  assert.equal(planned, false);
});

test('node label convergence waits for placement convergence', async () => {
  let status: 'PENDING' | 'CONVERGED' = 'PENDING';
  const agent = {
    checkServicePlacement: async () => ({
      serviceId: 'service-1',
      status,
      desiredReplicas: 1,
      runningReplicas: 1,
      reasons: status === 'PENDING' ? ['PLACEMENT_CONVERGENCE_PENDING'] : [],
      unsupportedConstraints: [],
      violations:
        status === 'PENDING'
          ? [
              {
                taskId: 'task-old',
                nodeId: 'node-b',
                reason: 'PLACEMENT_CONSTRAINT_MISMATCH',
              },
            ]
          : [],
    }),
  };

  const service = new NodeMutationService(
    agent as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const verifier = service as unknown as {
    affectedServicesConverged(serviceIds: string[]): Promise<boolean>;
  };

  assert.equal(
    await verifier.affectedServicesConverged(['service-1']),
    false,
  );

  status = 'CONVERGED';
  assert.equal(
    await verifier.affectedServicesConverged(['service-1']),
    true,
  );
});
