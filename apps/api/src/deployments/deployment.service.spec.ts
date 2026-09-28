import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ServiceDetailResponse,
  ServiceMutationPlan,
} from '../agent/read-model.js';
import type { OperationRecord } from '../operations/operation.types.js';
import type { DeploymentRecord } from './deployment.types.js';
import {
  classifyDeploymentReconciliationSnapshot,
  classifyDeploymentSnapshot,
  DeploymentService,
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
        specHash: 'target-task-spec',
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
        specHash: 'target-task-spec',
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
  targetTaskSpecHash: 'target-task-spec',
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

test('deployment keeps protection while Swarm rollback is in progress', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({ updateState: 'rollback_started' }),
      plan,
      digest,
      false,
    ),
    'PENDING',
  );
});

test('deployment fails after Swarm rollback reaches a terminal state', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({ updateState: 'rollback_completed' }),
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

test('no-op deployment ignores running tasks that are desired to shutdown', () => {
  const current = snapshot({ updateState: undefined });
  current.tasks[0]!.desiredState = 'shutdown';

  assert.equal(
    classifyDeploymentSnapshot(
      current,
      { ...plan, beforeSpecHash: 'target-spec' },
      digest,
      true,
    ),
    'PENDING',
  );
});

test('deployment requires unique running slots and target TaskSpec identity', () => {
  const duplicateSlot = snapshot();
  duplicateSlot.tasks[1]!.slot = 1;
  assert.equal(
    classifyDeploymentSnapshot(duplicateSlot, plan, digest, false),
    'PENDING',
  );

  const wrongTaskSpec = snapshot();
  wrongTaskSpec.tasks[0]!.specHash = 'old-task-spec';
  assert.equal(
    classifyDeploymentSnapshot(wrongTaskSpec, plan, digest, false),
    'PENDING',
  );
});

test('Docker image reference strips registry URL scheme and pins digest', () => {
  assert.equal(
    dockerImageReference('https://registry.example.com/team/api/', digest),
    image,
  );
});


const deploymentOperation: OperationRecord = {
  id: 'deploy-op-1',
  clusterId: 'default',
  serviceId: 'service-1',
  type: 'DEPLOY',
  status: 'RUNNING',
  actorId: 'operator-1',
  expectedVersion: 10,
  beforeSpecHash: 'before-spec',
  targetSpecHash: 'target-spec',
  targetForceUpdate: 0,
  targetReplicas: 2,
  targetImage: image,
  targetTaskSpecHash: 'target-task-spec',
  resultVersion: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

test('deployment reconciliation resumes when target spec is observed', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ version: 11, specHash: 'target-spec' }),
    ),
    'TARGET_OBSERVED',
  );
});

test('deployment reconciliation waits while only the before spec is visible', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ version: 10, specHash: 'before-spec', image: 'old-image' }),
    ),
    'WAITING_FOR_MUTATION',
  );
});

test('deployment reconciliation detects external service changes', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ version: 11, specHash: 'external-spec' }),
    ),
    'EXTERNAL_CONFLICT',
  );
});

test('deployment reconciliation keeps rollback in progress non-terminal', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ updateState: 'rollback_started' }),
    ),
    'ROLLBACK_IN_PROGRESS',
  );
});

test('deployment reconciliation treats completed rollback as terminal failure', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ updateState: 'rollback_completed' }),
    ),
    'FAILED',
  );
});

test('deployment bootstrap reconciles target state without replaying mutation', async () => {
  let mutationCalls = 0;
  let verifyingCalls = 0;
  let successCalls = 0;
  let auditCalls = 0;

  const operation: OperationRecord = { ...deploymentOperation };
  const deployment: DeploymentRecord = {
    id: 'deployment-1',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    status: 'DEPLOYING',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {
      specHash: operation.targetSpecHash,
      image,
      desiredReplicas: 2,
    },
    health: {
      url: 'https://health.example.com/ready',
      intervalMs: 100,
      timeoutMs: 1000,
      retries: 1,
      stabilityWindowMs: 500,
      expectedStatus: 200,
    },
    expectedServiceVersion: 10,
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };

  const operations = {
    listNonTerminal: async () => [operation],
    findWithConnection: async () => operation,
    markVerifying: async () => {
      verifyingCalls += 1;
      operation.status = 'VERIFYING';
      operation.resultVersion = 11;
    },
    markSuccess: async () => {
      successCalls += 1;
      operation.status = 'SUCCESS';
      operation.resultVersion = 11;
    },
    audit: async () => {
      auditCalls += 1;
    },
  };

  const deployments = {
    findByOperationWithConnection: async () => deployment,
    markVerifying: async () => {
      deployment.status = 'VERIFYING';
    },
    markSuccess: async () => {
      deployment.status = 'SUCCESS';
    },
    requireWithConnection: async () => deployment,
  };

  const agent = {
    inspectService: async () => snapshot(),
    updateServiceImage: async () => {
      mutationCalls += 1;
      throw new Error('must not replay deployment mutation');
    },
  };

  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };

  const lock = {
    withServiceLock: async (
      _clusterId: string,
      _serviceId: string,
      fn: (value: unknown) => Promise<unknown>,
    ) => fn(connection),
  };

  const service = new DeploymentService(
    {} as never,
    deployments as never,
    agent as never,
    operations as never,
    {} as never,
    lock as never,
    {} as never,
    { verify: async () => undefined } as never,
  );

  await service.onApplicationBootstrap();

  assert.equal(mutationCalls, 0);
  assert.equal(verifyingCalls, 1);
  assert.equal(successCalls, 1);
  assert.equal(auditCalls, 1);
  assert.equal(deployment.status, 'SUCCESS');
});


test('deployment does not persist SUCCESS when service changes during health stability', async () => {
  let inspectCalls = 0;
  let successCalls = 0;
  let attentionCalls = 0;

  const operation: OperationRecord = {
    ...deploymentOperation,
    status: 'VERIFYING',
  };
  const deployment: DeploymentRecord = {
    id: 'deployment-health-race',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    status: 'VERIFYING',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {
      specHash: operation.targetSpecHash,
      image,
      desiredReplicas: 2,
      taskSpecHash: operation.targetTaskSpecHash,
    },
    health: {
      url: 'https://health.example.com/ready',
      intervalMs: 100,
      timeoutMs: 1000,
      retries: 1,
      stabilityWindowMs: 500,
      expectedStatus: 200,
    },
    expectedServiceVersion: 10,
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };

  const operations = {
    markSuccess: async () => {
      successCalls += 1;
    },
    markNeedsAttention: async () => {
      attentionCalls += 1;
      operation.status = 'NEEDS_ATTENTION';
    },
    findWithConnection: async () => operation,
    audit: async () => undefined,
  };
  const deployments = {
    markSuccess: async () => {
      deployment.status = 'SUCCESS';
    },
    markNeedsAttention: async () => {
      deployment.status = 'NEEDS_ATTENTION';
    },
    requireWithConnection: async () => deployment,
  };
  const agent = {
    inspectService: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) return snapshot();
      return snapshot({ version: 12, specHash: 'external-spec' });
    },
  };
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const healthVerifier = {
    verify: async (
      _config: unknown,
      assertConverged?: () => Promise<void>,
    ) => {
      await assertConverged?.();
    },
  };

  const service = new DeploymentService(
    {} as never,
    deployments as never,
    agent as never,
    operations as never,
    {} as never,
    {} as never,
    {} as never,
    healthVerifier as never,
  );

  const verifier = service as unknown as {
    verifyAndComplete(
      connection: unknown,
      deploymentId: string,
      operationId: string,
      plan: ServiceMutationPlan,
      digest: string,
      noOp: boolean,
      health: DeploymentRecord['health'],
    ): Promise<DeploymentRecord>;
  };

  const result = await verifier.verifyAndComplete(
    connection,
    deployment.id,
    operation.id,
    plan,
    digest,
    false,
    deployment.health,
  );

  assert.equal(successCalls, 0);
  assert.equal(attentionCalls, 1);
  assert.equal(result.status, 'NEEDS_ATTENTION');
});
