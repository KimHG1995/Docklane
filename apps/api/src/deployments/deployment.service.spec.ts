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
  classifyRollbackSnapshot,
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
        runtimeSpecHash: 'target-runtime-spec',
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
        runtimeSpecHash: 'target-runtime-spec',
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
  targetRuntimeSpecHash: 'target-runtime-spec',
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

test('placement-only task spec drift is accepted by runtime fingerprint', () => {
  const current = snapshot();
  current.tasks[0]!.specHash = 'placement-old-task-spec';
  current.tasks[1]!.specHash = 'placement-old-task-spec';

  assert.equal(
    classifyDeploymentSnapshot(current, plan, digest, false),
    'SUCCESS',
  );
});

test('deployment requires unique running slots and target runtime fingerprint', () => {
  const duplicateSlot = snapshot();
  duplicateSlot.tasks[1]!.slot = 1;
  assert.equal(
    classifyDeploymentSnapshot(duplicateSlot, plan, digest, false),
    'PENDING',
  );

  const staleRuntimeSpec = snapshot();
  staleRuntimeSpec.tasks[0]!.runtimeSpecHash = 'stale-runtime-spec';
  assert.equal(
    classifyDeploymentSnapshot(staleRuntimeSpec, plan, digest, false),
    'PENDING',
  );
});

test('no-op deployment waits while a same-digest task still has stale runtime config', () => {
  const current = snapshot({ updateState: undefined });
  current.tasks[0]!.runtimeSpecHash = 'previous-runtime-spec';

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

test('rollback convergence accepts the restored spec and task set', () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  const rollbackPlan: ServiceMutationPlan = {
    serviceId: 'service-1',
    version: 12,
    beforeSpecHash: 'failed-spec',
    targetSpecHash: 'previous-spec',
    targetForceUpdate: 0,
    targetReplicas: 2,
    targetImage: rollbackImage,
    targetTaskSpecHash: 'previous-task-spec',
    targetRuntimeSpecHash: 'previous-runtime-spec',
  };
  const current = snapshot(
    {
      version: 13,
      specHash: 'previous-spec',
      image: rollbackImage,
      updateState: 'rollback_completed',
    },
    rollbackImage,
  );
  for (const task of current.tasks) {
    task.specHash = 'previous-task-spec';
    task.runtimeSpecHash = 'previous-runtime-spec';
  }

  assert.equal(
    classifyRollbackSnapshot(
      current,
      rollbackPlan,
      rollbackDigest,
    ),
    'SUCCESS',
  );
});

test('rollback convergence remains pending while rollback is running', () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  const rollbackPlan: ServiceMutationPlan = {
    serviceId: 'service-1',
    version: 12,
    beforeSpecHash: 'failed-spec',
    targetSpecHash: 'previous-spec',
    targetForceUpdate: 0,
    targetReplicas: 2,
    targetImage: rollbackImage,
    targetTaskSpecHash: 'previous-task-spec',
    targetRuntimeSpecHash: 'previous-runtime-spec',
  };

  assert.equal(
    classifyRollbackSnapshot(
      snapshot({
        version: 13,
        specHash: 'failed-spec',
        image,
        updateState: 'rollback_started',
      }),
      rollbackPlan,
      rollbackDigest,
    ),
    'PENDING',
  );
});

test('rollback convergence accepts task spec drift when runtime fingerprint matches', () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  const rollbackPlan: ServiceMutationPlan = {
    serviceId: 'service-1',
    version: 12,
    beforeSpecHash: 'failed-spec',
    targetSpecHash: 'previous-spec',
    targetForceUpdate: 0,
    targetReplicas: 2,
    targetImage: rollbackImage,
    targetTaskSpecHash: 'previous-task-spec',
    targetRuntimeSpecHash: 'previous-runtime-spec',
  };
  const current = snapshot(
    {
      version: 13,
      specHash: 'previous-spec',
      image: rollbackImage,
      updateState: 'rollback_completed',
    },
    rollbackImage,
  );
  for (const task of current.tasks) {
    task.specHash = 'docker-api-normalized-task-spec';
    task.runtimeSpecHash = 'previous-runtime-spec';
  }

  assert.equal(
    classifyRollbackSnapshot(
      current,
      rollbackPlan,
      rollbackDigest,
    ),
    'SUCCESS',
  );
});

test('rollback convergence waits on Swarm-materialized runtime fingerprint drift', () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  const rollbackPlan: ServiceMutationPlan = {
    serviceId: 'service-1',
    version: 12,
    beforeSpecHash: 'failed-spec',
    targetSpecHash: 'previous-spec',
    targetForceUpdate: 0,
    targetReplicas: 2,
    targetImage: rollbackImage,
    targetTaskSpecHash: 'previous-task-spec',
    targetRuntimeSpecHash: 'previous-runtime-spec',
  };
  const current = snapshot(
    {
      version: 13,
      specHash: 'previous-spec',
      image: rollbackImage,
      updateState: 'rollback_completed',
    },
    rollbackImage,
  );
  for (const task of current.tasks) {
    task.runtimeSpecHash = 'swarm-materialized-runtime-spec';
  }

  assert.equal(
    classifyRollbackSnapshot(
      current,
      rollbackPlan,
      rollbackDigest,
    ),
    'PENDING',
  );
});

test('rollback convergence rejects desired-shutdown restored tasks', () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  const rollbackPlan: ServiceMutationPlan = {
    serviceId: 'service-1',
    version: 12,
    beforeSpecHash: 'failed-spec',
    targetSpecHash: 'previous-spec',
    targetForceUpdate: 0,
    targetReplicas: 2,
    targetImage: rollbackImage,
    targetTaskSpecHash: 'previous-task-spec',
    targetRuntimeSpecHash: 'previous-runtime-spec',
  };
  const current = snapshot(
    {
      version: 13,
      specHash: 'previous-spec',
      image: rollbackImage,
      updateState: 'rollback_completed',
    },
    rollbackImage,
  );
  for (const task of current.tasks) {
    task.specHash = 'previous-task-spec';
    task.runtimeSpecHash = 'previous-runtime-spec';
  }
  current.tasks[0]!.desiredState = 'shutdown';

  assert.equal(
    classifyRollbackSnapshot(
      current,
      rollbackPlan,
      rollbackDigest,
    ),
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
  targetRuntimeSpecHash: 'target-runtime-spec',
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
test('automatic rollback restored spec stays in rollback observation instead of external conflict', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({
        version: 12,
        specHash: 'before-spec',
        updateState: 'rollback_started',
      }),
    ),
    'ROLLBACK_IN_PROGRESS',
  );
});

test('rollback_paused is an explicit protected rollback state', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({
        version: 12,
        specHash: 'before-spec',
        updateState: 'rollback_paused',
      }),
    ),
    'ROLLBACK_PAUSED',
  );

  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({
        version: 12,
        specHash: 'before-spec',
        updateState: 'rollback_paused',
      }),
      plan,
      digest,
      false,
    ),
    'ROLLBACK_PAUSED',
  );
});

test('deployment reconciliation observes target spec before interpreting completed rollback', () => {
  assert.equal(
    classifyDeploymentReconciliationSnapshot(
      deploymentOperation,
      snapshot({ updateState: 'rollback_completed' }),
    ),
    'TARGET_OBSERVED',
  );
});

test('deployment bootstrap reconciles target state without replaying mutation', async () => {
  let mutationCalls = 0;
  let verifyingCalls = 0;
  let successCalls = 0;
  let auditCalls = 0;

  const operation: OperationRecord = { ...deploymentOperation };
  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'deployment-1',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    rollbackOperationId: null,
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
    checkServicePlacement: async () => ({
      serviceId: 'service-1',
      status: 'CONVERGED',
      desiredReplicas: 2,
      runningReplicas: 2,
      reasons: [],
      unsupportedConstraints: [],
      violations: [],
    }),
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
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'deployment-health-race',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    rollbackOperationId: null,
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


test('manual rollback observes an existing Swarm rollback without replaying it', async () => {
  const rollbackDigest = `sha256:${'b'.repeat(64)}`;
  const rollbackImage =
    `registry.example.com/team/api@${rollbackDigest}`;
  let planRollbackCalls = 0;
  let rollbackMutationCalls = 0;
  let operation: OperationRecord | null = null;
  let persistedOperationStatus: OperationRecord['status'] | null = null;

  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'deployment-existing-rollback',
    releaseId: 'failed-release',
    previousReleaseId: 'previous-release',
    deploymentTargetId: 'target-1',
    operationId: 'deploy-op-failed',
    rollbackOperationId: null,
    status: 'FAILED',
    reason: 'health failed',
    noOp: false,
    beforeSpec: {
      specHash: 'previous-spec',
    },
    targetSpec: {
      specHash: 'failed-spec',
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };

  const current = snapshot(
    {
      id: 'service-1',
      version: 13,
      specHash: 'previous-spec',
      forceUpdate: 0,
      taskSpecHash: 'previous-task-spec',
      runtimeSpecHash: 'previous-runtime-spec',
      image: rollbackImage,
      updateState: 'rollback_completed',
    },
    rollbackImage,
  );
  for (const task of current.tasks) {
    task.specHash = 'previous-task-spec';
    task.runtimeSpecHash = 'previous-runtime-spec';
  }

  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    findRelease: async (id: string) =>
      id === 'previous-release'
        ? {
            id,
            applicationId: 'app-1',
            version: '1.0.0',
            imageRepository: 'registry.example.com/team/api',
            imageTag: '1.0.0',
            imageDigest: rollbackDigest,
            gitCommit: null,
            buildNumber: null,
            createdBy: 'operator-1',
            createdAt: new Date(0).toISOString(),
          }
        : null,
  };

  const deployments = {
    find: async () => deployment,
    findByRollbackOperation: async () => deployment.rollbackOperationId ? deployment : null,
    recordRollbackAttempt: async () => {},
    markRollingBack: async (
      _connection: unknown,
      _id: string,
      rollbackOperationId: string,
    ) => {
      deployment.status = 'ROLLING_BACK';
      deployment.rollbackOperationId = rollbackOperationId;
    },
    markRollbackVerifying: async () => {
      deployment.status = 'ROLLBACK_VERIFYING';
    },
    markRolledBack: async () => {
      deployment.status = 'ROLLED_BACK';
    },
    requireWithConnection: async () => deployment,
    findByRollbackOperationWithConnection: async () => deployment,
  };

  const agent = {
    inspectService: async () => current,
    checkServicePlacement: async () => ({
      serviceId: 'service-1',
      status: 'CONVERGED',
      desiredReplicas: 2,
      runningReplicas: 2,
      reasons: [],
      unsupportedConstraints: [],
      violations: [],
    }),
    planRollbackService: async () => {
      planRollbackCalls += 1;
      throw new Error('must not plan a second rollback');
    },
    rollbackService: async () => {
      rollbackMutationCalls += 1;
      throw new Error('must not replay rollback mutation');
    },
  };

  const operations = {
    find: async () => null,
    findWithConnection: async () => operation,
    findNonTerminalForServiceWithConnection: async () => null,
    create: async (_connection: unknown, input: {
      id: string;
      clusterId: string;
      serviceId: string;
      type: 'ROLLBACK';
      actorId: string;
      expectedVersion: number;
      beforeSpecHash: string;
      targetSpecHash: string;
      targetForceUpdate: number;
      targetReplicas?: number;
      targetImage?: string;
      targetTaskSpecHash?: string;
    }) => {
      operation = {
        ...input,
        targetReplicas: input.targetReplicas ?? null,
        targetImage: input.targetImage ?? null,
        targetTaskSpecHash: input.targetTaskSpecHash ?? null,
        status: 'PENDING',
        resultVersion: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    markRunning: async () => {
      if (operation) operation.status = 'RUNNING';
    },
    markVerifying: async (
      _connection: unknown,
      _id: string,
      version: number,
    ) => {
      if (operation) {
        operation.status = 'VERIFYING';
        operation.resultVersion = version;
      }
    },
    markSuccess: async (
      _connection: unknown,
      _id: string,
      version: number,
    ) => {
      if (operation) {
        operation.status = 'SUCCESS';
        operation.resultVersion = version;
        persistedOperationStatus = 'SUCCESS';
      }
    },
    audit: async () => undefined,
  };

  const nodeOperations = {
    findNonTerminalAffectingServiceWithConnection: async () => null,
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
    releases as never,
    deployments as never,
    agent as never,
    operations as never,
    nodeOperations as never,
    lock as never,
    {
      assertAvailable: async () => {
        throw new Error('capacity check must not run for existing rollback');
      },
    } as never,
    {
      verify: async (
        _config: unknown,
        assertConverged?: () => Promise<void>,
      ) => {
        await assertConverged?.();
      },
    } as never,
  );

  const result = await service.rollback(
    'default',
    deployment.id,
    { operationId: 'rollback-op-1' },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(planRollbackCalls, 0);
  assert.equal(rollbackMutationCalls, 0);
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(persistedOperationStatus, 'SUCCESS');
});


test('historical redeploy requires a successful deployment of the release on the same target', async () => {
  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    findRelease: async () => ({
      id: 'release-old',
      applicationId: 'app-1',
      version: '0.9.0',
      imageRepository: 'registry.example.com/team/api',
      imageTag: '0.9.0',
      imageDigest: digest,
      gitCommit: null,
      buildNumber: null,
      createdBy: 'operator-1',
      createdAt: new Date(0).toISOString(),
    }),
  };
  const deployments = {
    findByOperation: async () => null,
    findLatestSuccessfulForReleaseWithConnection: async () => null,
  };
  const lock = {
    withServiceLock: async (
      _clusterId: string,
      _serviceId: string,
      fn: (connection: unknown) => Promise<unknown>,
    ) => fn({}),
  };

  const service = new DeploymentService(
    releases as never,
    deployments as never,
    {} as never,
    {
      find: async () => null,
      findWithConnection: async () => null,
    } as never,
    {} as never,
    lock as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    service.historicalRedeploy(
      'default',
      'target-1',
      {
        operationId: 'redeploy-op-1',
        releaseId: 'release-old',
        health: {
          url: 'https://health.example.com/ready',
          intervalMs: 100,
          timeoutMs: 1000,
          retries: 1,
          stabilityWindowMs: 500,
          expectedStatus: 200,
        },
      },
      {
        actorId: 'operator-1',
        role: 'OPERATOR',
        clusters: ['default'],
      },
    ),
    /previously successful deployment/,
  );
});

test('deployment status view includes deploy and rollback operations', async () => {
  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'deployment-status',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: 'deploy-op-1',
    rollbackOperationId: 'rollback-op-1',
    status: 'ROLLBACK_VERIFYING',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
  const deployOperation: OperationRecord = {
    ...deploymentOperation,
    id: 'deploy-op-1',
    status: 'FAILED',
  };
  const rollbackOperation: OperationRecord = {
    ...deploymentOperation,
    id: 'rollback-op-1',
    type: 'ROLLBACK',
    status: 'VERIFYING',
  };

  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  };
  const deployments = {
    find: async () => deployment,
  };
  const operations = {
    find: async (id: string) =>
      id === 'deploy-op-1'
        ? deployOperation
        : id === 'rollback-op-1'
          ? rollbackOperation
          : null,
  };

  const service = new DeploymentService(
    releases as never,
    deployments as never,
    {} as never,
    operations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.status('default', deployment.id);
  assert.equal(result.operation?.id, 'deploy-op-1');
  assert.equal(result.rollbackOperation?.id, 'rollback-op-1');
  assert.equal(result.deployment.status, 'ROLLBACK_VERIFYING');
});


test('manual rollback rejects a service that no longer matches the failed deployment target', async () => {
  let rollbackMutationCalls = 0;
  const previousDigest = `sha256:${'b'.repeat(64)}`;
  const previousImage = `registry.example.com/team/api@${previousDigest}`;

  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'deployment-foreign-current',
    releaseId: 'release-b',
    previousReleaseId: 'release-a',
    deploymentTargetId: 'target-1',
    operationId: 'deploy-b',
    rollbackOperationId: null,
    status: 'FAILED',
    reason: 'cas conflict',
    noOp: false,
    beforeSpec: { specHash: 'spec-a' },
    targetSpec: { specHash: 'spec-b' },
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };

  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    findRelease: async () => ({
      id: 'release-a',
      applicationId: 'app-1',
      version: '1.0.0',
      imageRepository: 'registry.example.com/team/api',
      imageTag: '1.0.0',
      imageDigest: previousDigest,
      gitCommit: null,
      buildNumber: null,
      createdBy: 'operator-1',
      createdAt: new Date(0).toISOString(),
    }),
  };

  const deployments = {
    find: async () => deployment,
  };

  const current = snapshot({
    id: 'service-1',
    version: 20,
    specHash: 'spec-c',
    image: `registry.example.com/team/api@sha256:${'c'.repeat(64)}`,
    updateState: undefined,
  });

  const agent = {
    inspectService: async () => current,
    planRollbackService: async () => ({
      serviceId: 'service-1',
      version: 20,
      beforeSpecHash: 'spec-c',
      targetSpecHash: 'spec-a',
      targetForceUpdate: 0,
      targetReplicas: 2,
      targetImage: previousImage,
      targetTaskSpecHash: 'previous-task-spec',
      targetRuntimeSpecHash: 'previous-runtime-spec',
    }),
    rollbackService: async () => {
      rollbackMutationCalls += 1;
      throw new Error('must not rollback unrelated current service');
    },
  };

  const operations = {
    find: async () => null,
    findWithConnection: async () => null,
    findNonTerminalForServiceWithConnection: async () => null,
  };
  const nodeOperations = {
    findNonTerminalAffectingServiceWithConnection: async () => null,
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
    releases as never,
    deployments as never,
    agent as never,
    operations as never,
    nodeOperations as never,
    lock as never,
    { assertAvailable: async () => undefined } as never,
    {} as never,
  );

  await assert.rejects(
    service.rollback(
      'default',
      deployment.id,
      { operationId: 'rollback-b' },
      {
        actorId: 'operator-1',
        role: 'OPERATOR',
        clusters: ['default'],
      },
    ),
    /rollback ownership/,
  );
  assert.equal(rollbackMutationCalls, 0);
});

test('historical redeploy retry reuses stored source provenance', async () => {
  const stored: DeploymentRecord = {
    kind: 'HISTORICAL_REDEPLOY',
    sourceDeploymentId: 'source-original',
    id: 'redeploy-result',
    releaseId: 'release-old',
    previousReleaseId: 'release-new',
    deploymentTargetId: 'target-1',
    operationId: 'redeploy-op',
    rollbackOperationId: null,
    status: 'SUCCESS',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };
  let latestSourceLookups = 0;
  let agentInspectCalls = 0;

  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    findRelease: async () => ({
      id: 'release-old',
      applicationId: 'app-1',
      version: '0.9.0',
      imageRepository: 'registry.example.com/team/api',
      imageTag: '0.9.0',
      imageDigest: digest,
      gitCommit: null,
      buildNumber: null,
      createdBy: 'operator-1',
      createdAt: new Date(0).toISOString(),
    }),
  };

  const deployments = {
    findByOperation: async () => stored,
    findLatestSuccessfulForRelease: async () => {
      latestSourceLookups += 1;
      return {
        ...stored,
        id: 'redeploy-result',
      };
    },
    findByOperationWithConnection: async () => stored,
  };

  const operation: OperationRecord = {
    ...deploymentOperation,
    id: 'redeploy-op',
    status: 'SUCCESS',
  };
  const operations = {
    find: async () => operation,
    findWithConnection: async () => operation,
  };
  const agent = {
    inspectService: async () => {
      agentInspectCalls += 1;
      return snapshot();
    },
  };
  const connection = {};
  const lock = {
    withServiceLock: async (
      _clusterId: string,
      _serviceId: string,
      fn: (value: unknown) => Promise<unknown>,
    ) => fn(connection),
  };

  const service = new DeploymentService(
    releases as never,
    deployments as never,
    agent as never,
    operations as never,
    {} as never,
    lock as never,
    {} as never,
    {} as never,
  );

  const result = await service.historicalRedeploy(
    'default',
    'target-1',
    {
      operationId: 'redeploy-op',
      releaseId: 'release-old',
      health: stored.health,
    },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(result.id, stored.id);
  assert.equal(result.sourceDeploymentId, 'source-original');
  assert.equal(latestSourceLookups, 0);
  assert.equal(agentInspectCalls, 0);
});


test('deployment convergence requires placement after runtime fingerprint matches', async () => {
  let placementStatus: 'CONVERGED' | 'PENDING' = 'PENDING';
  const agent = {
    checkServicePlacement: async () => ({
      serviceId: 'service-1',
      status: placementStatus,
      desiredReplicas: 2,
      runningReplicas: 2,
      reasons:
        placementStatus === 'CONVERGED'
          ? []
          : ['PLACEMENT_CONVERGENCE_PENDING'],
      unsupportedConstraints: [],
      violations: [],
    }),
  };
  const service = new DeploymentService(
    {} as never,
    {} as never,
    agent as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const classifier = service as unknown as {
    classifyDeploymentConvergence(
      current: ServiceDetailResponse,
      plan: ServiceMutationPlan,
      digest: string,
      noOp: boolean,
    ): Promise<'PENDING' | 'SUCCESS' | 'ROLLBACK_PAUSED' | 'FAILED' | 'EXTERNAL_CONFLICT'>;
  };

  const current = snapshot();
  current.tasks[0]!.specHash = 'old-placement-spec';
  current.tasks[1]!.specHash = 'old-placement-spec';

  assert.equal(
    await classifier.classifyDeploymentConvergence(
      current,
      plan,
      digest,
      false,
    ),
    'PENDING',
  );

  placementStatus = 'CONVERGED';
  assert.equal(
    await classifier.classifyDeploymentConvergence(
      current,
      plan,
      digest,
      false,
    ),
    'SUCCESS',
  );
});


test('external spec with paused or rollback_completed stays protected as external conflict', () => {
  for (const updateState of ['paused', 'rollback_completed'] as const) {
    assert.equal(
      classifyDeploymentSnapshot(
        snapshot({
          version: 20,
          specHash: 'external-spec',
          updateState,
        }),
        plan,
        digest,
        false,
      ),
      'EXTERNAL_CONFLICT',
    );

    assert.equal(
      classifyDeploymentReconciliationSnapshot(
        deploymentOperation,
        snapshot({
          version: 20,
          specHash: 'external-spec',
          updateState,
        }),
      ),
      'EXTERNAL_CONFLICT',
    );
  }
});

test('no-op deploy accepts stale rollback_completed when target state already matches', () => {
  assert.equal(
    classifyDeploymentSnapshot(
      snapshot({
        version: 20,
        specHash: 'target-spec',
        updateState: 'rollback_completed',
      }),
      { ...plan, beforeSpecHash: 'target-spec' },
      digest,
      true,
    ),
    'SUCCESS',
  );
});

test('legacy deploy and rollback intents safely backfill runtime fingerprint', async () => {
  const legacyDeploy: OperationRecord = {
    ...deploymentOperation,
    id: 'legacy-deploy',
    type: 'DEPLOY',
    targetRuntimeSpecHash: null,
  };
  const legacyRollback: OperationRecord = {
    ...deploymentOperation,
    id: 'legacy-rollback',
    type: 'ROLLBACK',
    targetRuntimeSpecHash: null,
  };

  let inspectCalls = 0;
  const backfilled: Array<{ id: string; hash: string }> = [];
  const agent = {
    inspectService: async () => {
      inspectCalls += 1;
      return snapshot({
        specHash: 'target-spec',
        runtimeSpecHash: 'legacy-runtime-spec',
      });
    },
  };
  const operations = {
    backfillTargetRuntimeSpecHash: async (
      _connection: unknown,
      id: string,
      hash: string,
    ) => {
      backfilled.push({ id, hash });
    },
  };
  const service = new DeploymentService(
    {} as never,
    {} as never,
    agent as never,
    operations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const compat = service as unknown as {
    hydrateLegacyRuntimeFingerprint(
      connection: unknown,
      operation: OperationRecord,
    ): Promise<OperationRecord | null>;
  };

  const deployResult = await compat.hydrateLegacyRuntimeFingerprint(
    {},
    legacyDeploy,
  );
  const rollbackResult = await compat.hydrateLegacyRuntimeFingerprint(
    {},
    legacyRollback,
  );

  assert.equal(inspectCalls, 2);
  assert.equal(deployResult?.targetRuntimeSpecHash, 'legacy-runtime-spec');
  assert.equal(rollbackResult?.targetRuntimeSpecHash, 'legacy-runtime-spec');
  assert.deepEqual(backfilled, [
    { id: 'legacy-deploy', hash: 'legacy-runtime-spec' },
    { id: 'legacy-rollback', hash: 'legacy-runtime-spec' },
  ]);
});

test('historical redeploy race reuses persisted provenance inside service lock', async () => {
  const stored: DeploymentRecord = {
    kind: 'HISTORICAL_REDEPLOY',
    sourceDeploymentId: 'source-original',
    id: 'redeploy-race-result',
    releaseId: 'release-old',
    previousReleaseId: 'release-new',
    deploymentTargetId: 'target-1',
    operationId: 'redeploy-race-op',
    rollbackOperationId: null,
    status: 'SUCCESS',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };
  const existingOperation: OperationRecord = {
    ...deploymentOperation,
    id: stored.operationId,
    status: 'SUCCESS',
  };
  let poolFindCalls = 0;
  let sourceLookups = 0;
  let agentCalls = 0;

  const releases = {
    findDeploymentTarget: async () => ({
      id: 'target-1',
      applicationId: 'app-1',
      clusterId: 'default',
      environment: 'production',
      dockerServiceId: 'service-1',
      serviceName: 'api',
      routingMode: 'INGRESS',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    findRelease: async () => ({
      id: 'release-old',
      applicationId: 'app-1',
      version: '0.9.0',
      imageRepository: 'registry.example.com/team/api',
      imageTag: '0.9.0',
      imageDigest: digest,
      gitCommit: null,
      buildNumber: null,
      createdBy: 'operator-1',
      createdAt: new Date(0).toISOString(),
    }),
  };
  const deployments = {
    findByOperation: async () => {
      poolFindCalls += 1;
      return null;
    },
    findByOperationWithConnection: async () => stored,
    findLatestSuccessfulForReleaseWithConnection: async () => {
      sourceLookups += 1;
      return {
        ...stored,
        id: 'new-latest-source',
      };
    },
  };
  const operations = {
    find: async () => null,
    findWithConnection: async () => existingOperation,
  };
  const agent = {
    inspectService: async () => {
      agentCalls += 1;
      throw new Error('terminal race retry must not inspect Agent');
    },
  };
  const lock = {
    withServiceLock: async (
      _clusterId: string,
      _serviceId: string,
      fn: (connection: unknown) => Promise<unknown>,
    ) => fn({}),
  };
  const service = new DeploymentService(
    releases as never,
    deployments as never,
    agent as never,
    operations as never,
    {} as never,
    lock as never,
    {} as never,
    {} as never,
  );

  const result = await service.historicalRedeploy(
    'default',
    'target-1',
    {
      operationId: stored.operationId,
      releaseId: stored.releaseId,
      health: stored.health,
    },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(result.id, stored.id);
  assert.equal(result.sourceDeploymentId, 'source-original');
  assert.equal(poolFindCalls, 0);
  assert.equal(sourceLookups, 0);
  assert.equal(agentCalls, 0);
});

test('terminal deploy retry returns persisted result before Agent lookup', async () => {
  const stored: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'terminal-deploy',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: 'terminal-deploy-op',
    rollbackOperationId: null,
    status: 'SUCCESS',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };
  const operation: OperationRecord = {
    ...deploymentOperation,
    id: stored.operationId,
    status: 'SUCCESS',
  };
  let agentCalls = 0;
  const service = new DeploymentService(
    {
      findDeploymentTarget: async () => ({
        id: 'target-1',
        applicationId: 'app-1',
        clusterId: 'default',
        dockerServiceId: 'service-1',
      }),
      findRelease: async () => ({
        id: 'release-1',
        applicationId: 'app-1',
      }),
    } as never,
    {
      findByOperation: async () => stored,
    } as never,
    {
      inspectService: async () => {
        agentCalls += 1;
        throw new Error('Agent unavailable');
      },
    } as never,
    {
      find: async () => operation,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.deploy(
    'default',
    'target-1',
    {
      operationId: stored.operationId,
      releaseId: stored.releaseId,
      health: stored.health,
    },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(result.id, stored.id);
  assert.equal(agentCalls, 0);
});

test('terminal rollback retry returns persisted result before Agent lookup', async () => {
  const stored: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'terminal-rollback',
    releaseId: 'release-b',
    previousReleaseId: 'release-a',
    deploymentTargetId: 'target-1',
    operationId: 'deploy-b',
    rollbackOperationId: 'rollback-terminal-op',
    status: 'ROLLED_BACK',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };
  const rollbackOperation: OperationRecord = {
    ...deploymentOperation,
    id: stored.rollbackOperationId!,
    type: 'ROLLBACK',
    status: 'SUCCESS',
  };
  let agentCalls = 0;
  const service = new DeploymentService(
    {
      findDeploymentTarget: async () => ({
        id: 'target-1',
        applicationId: 'app-1',
        clusterId: 'default',
        dockerServiceId: 'service-1',
      }),
      findRelease: async () => ({
        id: 'release-a',
        applicationId: 'app-1',
      }),
    } as never,
    {
      find: async () => stored,
      findByRollbackOperation: async (id: string) => id === stored.rollbackOperationId ? stored : null,
    } as never,
    {
      inspectService: async () => {
        agentCalls += 1;
        throw new Error('Agent unavailable');
      },
    } as never,
    {
      find: async () => rollbackOperation,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.rollback(
    'default',
    stored.id,
    { operationId: stored.rollbackOperationId! },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(result.id, stored.id);
  assert.equal(agentCalls, 0);
});


test('legacy runtime hydration failure keeps deployment protected for retry', async () => {
  const operation: OperationRecord = {
    ...deploymentOperation,
    id: 'legacy-unavailable',
    status: 'VERIFYING',
    targetRuntimeSpecHash: null,
  };
  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'legacy-unavailable-deployment',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    rollbackOperationId: null,
    status: 'VERIFYING',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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

  let pendingCalls = 0;
  let attentionCalls = 0;
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const operations = {
    backfillTargetRuntimeSpecHash: async () => undefined,
    markVerificationPending: async () => {
      pendingCalls += 1;
    },
    markNeedsAttention: async () => {
      attentionCalls += 1;
    },
    findWithConnection: async () => operation,
    audit: async () => undefined,
  };
  const deployments = {
    markVerificationPending: async () => {
      deployment.status = 'VERIFYING';
    },
    requireWithConnection: async () => deployment,
  };
  const agent = {
    inspectService: async () => {
      throw new Error('Agent unavailable');
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
    {} as never,
  );
  const reconciler = service as unknown as {
    reconcileLocked(
      connection: unknown,
      operation: OperationRecord,
      deployment: DeploymentRecord,
    ): Promise<DeploymentRecord>;
  };

  const result = await reconciler.reconcileLocked(
    connection,
    operation,
    deployment,
  );

  assert.equal(result.status, 'VERIFYING');
  assert.equal(pendingCalls, 1);
  assert.equal(attentionCalls, 0);
});


test('legacy deployment with definite external spec becomes NEEDS_ATTENTION', async () => {
  const operation: OperationRecord = {
    ...deploymentOperation,
    id: 'legacy-external-deploy',
    status: 'VERIFYING',
    targetRuntimeSpecHash: null,
  };
  const deployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'legacy-external-deployment',
    releaseId: 'release-1',
    previousReleaseId: null,
    deploymentTargetId: 'target-1',
    operationId: operation.id,
    rollbackOperationId: null,
    status: 'VERIFYING',
    reason: null,
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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

  let pendingCalls = 0;
  let attentionCalls = 0;
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const operations = {
    markVerificationPending: async () => {
      pendingCalls += 1;
    },
    markNeedsAttention: async () => {
      attentionCalls += 1;
      operation.status = 'NEEDS_ATTENTION';
    },
    findWithConnection: async () => operation,
    audit: async () => undefined,
  };
  const deployments = {
    markVerificationPending: async () => {
      deployment.status = 'VERIFYING';
    },
    markNeedsAttention: async () => {
      deployment.status = 'NEEDS_ATTENTION';
    },
    requireWithConnection: async () => deployment,
  };
  const agent = {
    inspectService: async () =>
      snapshot({
        version: 20,
        specHash: 'external-spec',
      }),
  };

  const service = new DeploymentService(
    {} as never,
    deployments as never,
    agent as never,
    operations as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const reconciler = service as unknown as {
    reconcileLocked(
      connection: unknown,
      operation: OperationRecord,
      deployment: DeploymentRecord,
    ): Promise<DeploymentRecord>;
  };

  const result = await reconciler.reconcileLocked(
    connection,
    operation,
    deployment,
  );

  assert.equal(result.status, 'NEEDS_ATTENTION');
  assert.equal(attentionCalls, 1);
  assert.equal(pendingCalls, 0);
});

test('terminal rollback retry refreshes the latest deployment row', async () => {
  const staleDeployment: DeploymentRecord = {
    kind: 'DEPLOY',
    sourceDeploymentId: null,
    id: 'rollback-race-deployment',
    releaseId: 'release-b',
    previousReleaseId: 'release-a',
    deploymentTargetId: 'target-1',
    operationId: 'deploy-b',
    rollbackOperationId: null,
    status: 'FAILED',
    reason: 'health failed',
    noOp: false,
    beforeSpec: {},
    targetSpec: {},
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
    finishedAt: new Date(1).toISOString(),
    createdBy: 'operator-1',
    createdAt: new Date(0).toISOString(),
  };
  const latestDeployment: DeploymentRecord = {
    ...staleDeployment,
    rollbackOperationId: 'rollback-race-op',
    status: 'ROLLED_BACK',
    reason: null,
  };
  const rollbackOperation: OperationRecord = {
    ...deploymentOperation,
    id: 'rollback-race-op',
    type: 'ROLLBACK',
    status: 'SUCCESS',
  };

  let deploymentFindCalls = 0;
  let agentCalls = 0;
  const service = new DeploymentService(
    {
      findDeploymentTarget: async () => ({
        id: 'target-1',
        applicationId: 'app-1',
        clusterId: 'default',
        dockerServiceId: 'service-1',
      }),
      findRelease: async () => ({
        id: 'release-a',
        applicationId: 'app-1',
      }),
    } as never,
    {
      find: async () => {
        deploymentFindCalls += 1;
        return deploymentFindCalls === 1
          ? staleDeployment
          : latestDeployment;
      },
      findByRollbackOperation: async (id: string) => id === 'rollback-race-op' ? latestDeployment : null,
    } as never,
    {
      inspectService: async () => {
        agentCalls += 1;
        throw new Error('terminal retry must not inspect Agent');
      },
    } as never,
    {
      find: async () => rollbackOperation,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.rollback(
    'default',
    staleDeployment.id,
    { operationId: 'rollback-race-op' },
    {
      actorId: 'operator-1',
      role: 'OPERATOR',
      clusters: ['default'],
    },
  );

  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.rollbackOperationId, 'rollback-race-op');
  assert.equal(deploymentFindCalls, 2);
  assert.equal(agentCalls, 0);
});

test('rejected rollback A stays replayable after rollback B replaces the current deployment pointer', async () => {
  const original: DeploymentRecord = {
    kind: 'DEPLOY', sourceDeploymentId: null, id: 'deployment-a',
    releaseId: 'new-release', previousReleaseId: 'old-release', deploymentTargetId: 'target-1',
    operationId: 'deploy-op', rollbackOperationId: 'rollback-B', status: 'FAILED',
    reason: 'B was rejected', noOp: false, beforeSpec: {}, targetSpec: {},
    health: { url: 'https://health.example.com/ready', intervalMs: 100, timeoutMs: 1000,
      retries: 1, stabilityWindowMs: 500, expectedStatus: 200 },
    expectedServiceVersion: 10, startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(), createdBy: 'operator-1', createdAt: new Date(0).toISOString(),
  };
  const operations = new Map([
    ['rollback-A', { ...deploymentOperation, id: 'rollback-A', type: 'ROLLBACK' as const,
      status: 'FAILED' as const, actorId: 'operator-1', clusterId: 'default',
      serviceId: 'service-1', errorMessage: 'guard A rejected' }],
    ['rollback-B', { ...deploymentOperation, id: 'rollback-B', type: 'ROLLBACK' as const,
      status: 'FAILED' as const, actorId: 'operator-1', clusterId: 'default',
      serviceId: 'service-1', errorMessage: 'guard B rejected' }],
  ]);
  let agentCalls = 0;
  const repository = {
    find: async () => ({ ...original }),
    findByRollbackOperation: async (id: string) =>
      operations.has(id) ? { ...original } : null,
  };
  const service = new DeploymentService(
    { findDeploymentTarget: async () => ({
      id: 'target-1', applicationId: 'app-1', clusterId: 'default', dockerServiceId: 'service-1',
    }), findRelease: async () => ({ id: 'old-release', applicationId: 'app-1' }) } as never,
    repository as never,
    { inspectService: async () => { agentCalls++; throw Error('must not contact Agent'); } } as never,
    { find: async (id: string) => operations.get(id) ?? null } as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  const principal = { actorId: 'operator-1', role: 'OPERATOR' as const, clusters: ['default'] };
  const old = await service.rollback('default', original.id, { operationId: 'rollback-A' }, principal);
  const next = await service.rollback('default', original.id, { operationId: 'rollback-B' }, principal);
  const again = await service.rollback('default', original.id, { operationId: 'rollback-A' }, principal);
  assert.equal(old.rollbackOperationId, 'rollback-A');
  assert.equal(old.status, 'FAILED');
  assert.equal(old.reason, 'guard A rejected');
  assert.equal(next.rollbackOperationId, 'rollback-B');
  assert.deepEqual(old, again);
  assert.equal(agentCalls, 0);
});
