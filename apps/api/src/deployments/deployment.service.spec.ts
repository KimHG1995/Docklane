import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ServiceDetailResponse,
  ServiceMutationPlan,
} from '../agent/read-model.js';
import {
  classifyDeploymentSnapshot,
  dockerImageReference,
} from './deployment.service.js';

const digest = `sha256:${'a'.repeat(64)}`;
const image = `registry.example.com/team/api@${digest}`;

function snapshot(
  overrides: Partial<ServiceDetailResponse['service']> = {},
  taskImage = image,
): ServiceDetailResponse {
  return {
    service: {
      id: 'service-1',
      name: 'api',
      version: 11,
      specHash: 'target-spec',
      forceUpdate: 0,
      image,
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
        nodeId: 'node-1',
        desiredState: 'running',
        state: 'running',
        forceUpdate: 0,
        image: taskImage,
        timestamp: new Date(0).toISOString(),
      },
      {
        id: 'task-2',
        serviceId: 'service-1',
        slot: 2,
        nodeId: 'node-2',
        desiredState: 'running',
        state: 'running',
        forceUpdate: 0,
        image: taskImage,
        timestamp: new Date(0).toISOString(),
      },
    ],
  };
}

const plan: ServiceMutationPlan = {
  serviceId: 'service-1',
  version: 10,
  beforeSpecHash: 'before-spec',
  targetSpecHash: 'target-spec',
  targetForceUpdate: 0,
  targetImage: image,
};

test('deployment convergence succeeds only when service and tasks use target digest', () => {
  assert.equal(
    classifyDeploymentSnapshot(snapshot(), plan, digest, false),
    'SUCCESS',
  );
});

test('deployment waits while a running task still uses the previous digest', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({}, `registry.example.com/team/api@sha256:${'b'.repeat(64)}`),
      plan,
      digest,
      false,
    ),
    'PENDING',
  );
});

test('no-op deployment does not require a new completed update state', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({ updateState: undefined }),
      { ...plan, beforeSpecHash: 'target-spec' },
      digest,
      true,
    ),
    'SUCCESS',
  );
});

test('deployment fails when Swarm enters rollback state', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({ updateState: 'rollback_started' }),
      plan,
      digest,
      false,
    ),
    'FAILED',
  );
});

test('deployment detects an externally changed service spec', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({ version: 12, specHash: 'external-spec' }),
      plan,
      digest,
      false,
    ),
    'EXTERNAL_CONFLICT',
  );
});

test('Docker image reference strips registry URL scheme and pins digest', () => {
  assert.equal(
    dockerImageReference('https://registry.example.com/team/api/', digest),
    image,
  );
});
