import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNodeMutation } from './node-mutation-verification.js';
import type { NodeDetailResponse } from '../agent/read-model.js';
import type { NodeOperationRecord } from './operation.types.js';

const drainOperation: NodeOperationRecord = {
  id: 'node-op-1',
  clusterId: 'default',
  nodeId: 'node-1',
  type: 'DRAIN',
  status: 'VERIFYING',
  actorId: 'tester',
  expectedVersion: 10,
  beforeSpecHash: 'before',
  targetSpecHash: 'drain-target',
  targetAvailability: 'drain',
  affectedServiceIds: ['service-1'],
  resultVersion: 11,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function nodeSnapshot(
  overrides?: Partial<NodeDetailResponse['node']>,
  tasks: NodeDetailResponse['tasks'] = [],
): NodeDetailResponse {
  return {
    node: {
      id: 'node-1',
      version: 12,
      specHash: 'drain-target',
      hostname: 'worker-1',
      address: '10.0.0.10',
      role: 'worker',
      availability: 'drain',
      state: 'ready',
      manager: false,
      leader: false,
      nanoCpus: 2_000_000_000,
      memoryBytes: 4_000_000_000,
      ...overrides,
    },
    tasks,
    serviceIds: [],
  };
}

test('drain succeeds after metadata version advances and service tasks leave', () => {
  assert.deepEqual(
    classifyNodeMutation(drainOperation, nodeSnapshot({ version: 12 })),
    { status: 'SUCCESS' },
  );
});

test('drain waits while a non-terminal service task remains on the node', () => {
  const current = nodeSnapshot(undefined, [
    {
      id: 'task-1',
      serviceId: 'service-1',
      slot: 1,
      desiredState: 'shutdown',
      state: 'running',
      forceUpdate: 0,
      timestamp: new Date(0).toISOString(),
    },
  ]);
  assert.deepEqual(classifyNodeMutation(drainOperation, current), {
    status: 'PENDING',
  });
});

test('node snapshot older than accepted version remains pending', () => {
  assert.deepEqual(
    classifyNodeMutation(
      drainOperation,
      nodeSnapshot({ version: 10, specHash: 'before', availability: 'active' }),
    ),
    { status: 'PENDING' },
  );
});

test('external NodeSpec change is detected', () => {
  const decision = classifyNodeMutation(
    drainOperation,
    nodeSnapshot({ version: 20, specHash: 'external' }),
  );
  assert.equal(decision.status, 'EXTERNAL_CONFLICT');
});

test('activate succeeds when availability converges without requiring tasks', () => {
  const operation: NodeOperationRecord = {
    ...drainOperation,
    type: 'ACTIVATE',
    targetSpecHash: 'active-target',
    targetAvailability: 'active',
    affectedServiceIds: [],
  };
  const current = nodeSnapshot({
    version: 13,
    specHash: 'active-target',
    availability: 'active',
  });
  assert.deepEqual(classifyNodeMutation(operation, current), {
    status: 'SUCCESS',
  });
});
