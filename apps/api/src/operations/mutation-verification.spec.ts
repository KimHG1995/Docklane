import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMutationSnapshot } from './mutation-verification.js';
import type { OperationRecord } from './operation.types.js';
import type { ServiceDetailResponse } from '../agent/read-model.js';

const baseOperation: OperationRecord = {
  id: 'op-1',
  clusterId: 'default',
  serviceId: 'service-1',
  type: 'RESTART',
  status: 'VERIFYING',
  actorId: 'tester',
  expectedVersion: 10,
  beforeSpecHash: 'before',
  targetSpecHash: 'target',
  targetForceUpdate: 3,
  targetReplicas: null,
  resultVersion: 11,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function snapshot(overrides?: Partial<ServiceDetailResponse['service']>): ServiceDetailResponse {
  return {
    service: {
      id: 'service-1',
      name: 'api',
      version: 12,
      specHash: 'target',
      forceUpdate: 3,
      image: 'example@sha256:123',
      mode: 'replicated',
      desiredReplicas: 2,
      runningReplicas: 2,
      updateState: 'completed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...overrides,
    },
    tasks: [
      {
        id: 'task-1',
        serviceId: 'service-1',
        slot: 1,
        desiredState: 'running',
        state: 'running',
        forceUpdate: 3,
        timestamp: new Date(0).toISOString(),
      },
      {
        id: 'task-2',
        serviceId: 'service-1',
        slot: 2,
        desiredState: 'running',
        state: 'running',
        forceUpdate: 3,
        timestamp: new Date(0).toISOString(),
      },
    ],
  };
}

test('accepts Swarm metadata version advancement after target convergence', () => {
  const decision = classifyMutationSnapshot(baseOperation, snapshot({ version: 12 }));
  assert.deepEqual(decision, { status: 'SUCCESS' });
});

test('detects external service spec changes regardless of metadata version', () => {
  const decision = classifyMutationSnapshot(
    baseOperation,
    snapshot({ version: 20, specHash: 'external' }),
  );
  assert.equal(decision.status, 'EXTERNAL_CONFLICT');
});

test('treats an older pre-target snapshot as pending', () => {
  const decision = classifyMutationSnapshot(
    baseOperation,
    snapshot({
      version: 10,
      specHash: 'before',
      forceUpdate: 2,
      updateState: 'updating',
    }),
  );
  assert.deepEqual(decision, { status: 'PENDING' });
});
