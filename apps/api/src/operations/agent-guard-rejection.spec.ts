import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { AgentRequestError, type AgentClient } from '../agent/agent-client.js';
import type {
  NodeDetailResponse, NodeMutationPlan, ServiceDetailResponse, ServiceImageMutationPlan,
} from '../agent/read-model.js';
import type { Principal } from '../auth/auth.types.js';
import type { CapacityService } from '../capacity/capacity.service.js';
import { DeploymentService } from '../deployments/deployment.service.js';
import type { DeploymentRepository } from '../deployments/deployment.repository.js';
import type { DeploymentRecord, DeploymentStatus } from '../deployments/deployment.types.js';
import type { HealthVerifier } from '../deployments/health-verifier.js';
import type { ReleaseRepository } from '../releases/release.repository.js';
import { MutationService } from './mutation.service.js';
import { NodeMutationService } from './node-mutation.service.js';
import type { NodeOperationRepository } from './node-operation.repository.js';
import type { OperationLock } from './operation-lock.js';
import type { OperationRepository } from './operation.repository.js';
import type { AuditEventInput, NodeOperationRecord, OperationRecord, OperationStatus } from './operation.types.js';

const cluster = 'default';
const principal = { actorId: 'operator', role: 'ADMIN', clusters: [cluster] } as Principal;
const timestamp = '2026-01-01T00:00:00.000Z';
const oldDigest = 'sha256:' + 'a'.repeat(64);
const newDigest = 'sha256:' + 'b'.repeat(64);
const health = { url: 'https://example.invalid/health', expectedStatus: 200,
  intervalMs: 1, timeoutMs: 100, retries: 1, stabilityWindowMs: 0 };
const actions = ['scale', 'restart', 'drain', 'activate', 'labels', 'deploy', 'historical', 'rollback'] as const;
type Action = (typeof actions)[number];
const guardErrors = [
  [412, 'CLUSTER_PRECONDITION_FAILED'],
  [428, 'CLUSTER_PRECONDITION_REQUIRED'],
  [503, 'CLUSTER_IDENTITY_UNAVAILABLE'],
] as const;
const terminal = (row: { status: string }) => row.status === 'SUCCESS' || row.status === 'FAILED';
const copy = <T>(value: T): T => structuredClone(value);

// Real coordinators and classifiers. Only Agent, persistence/transactions, locks,
// capacity and HTTP health transport are doubles; no coordinator method is replaced.
function fixture(action: Action, error: Error | null) {
  const serviceRows = new Map<string, OperationRecord>();
  const nodeRows = new Map<string, NodeOperationRecord>();
  const deploymentRows = new Map<string, DeploymentRecord>();
  const audit: AuditEventInput[] = [];
  const state = { error, applied: false, applyBeforeError: false, planError: null as Error | null,
    failRejectionAudit: false, sends: 0, plans: 0, reads: 0, rollbackCalls: 0 };
  const before: ServiceDetailResponse = {
    service: { id: 'svc', name: 'svc', version: 1, specHash: 'before', forceUpdate: 0,
      mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, updateState: 'completed',
      image: `repo@${oldDigest}`, taskSpecHash: 'task-before', runtimeSpecHash: 'runtime-before',
      createdAt: timestamp, updatedAt: timestamp },
    tasks: [],
  };
  const plan: ServiceImageMutationPlan = {
    serviceId: 'svc', version: 1, beforeSpecHash: 'before', targetSpecHash: 'after',
    targetForceUpdate: action === 'restart' ? 1 : 0, targetReplicas: action === 'scale' ? 2 : 1,
    targetImage: `repo@${action === 'rollback' ? oldDigest : newDigest}`,
    targetTaskSpecHash: 'task-after', targetRuntimeSpecHash: 'runtime-after',
  };
  if (action === 'rollback') before.service.image = `repo@${newDigest}`;
  const after: ServiceDetailResponse = {
    service: { ...before.service, version: 2, specHash: 'after', forceUpdate: plan.targetForceUpdate,
      desiredReplicas: plan.targetReplicas!, runningReplicas: plan.targetReplicas!,
      image: plan.targetImage, taskSpecHash: 'task-after', runtimeSpecHash: 'runtime-after' },
    tasks: Array.from({ length: plan.targetReplicas! }, (_, i) => ({
      id: `task-${i}`, serviceId: 'svc', slot: i + 1, specHash: 'task-after',
      runtimeSpecHash: 'runtime-after', image: plan.targetImage, state: 'running',
      desiredState: 'running', forceUpdate: plan.targetForceUpdate, timestamp,
    })),
  };
  const nodeBefore: NodeDetailResponse = {
    node: { id: 'node', version: 1, specHash: 'node-before', hostname: 'node', address: '127.0.0.1',
      role: 'worker', availability: action === 'activate' ? 'drain' : 'active', state: 'ready',
      manager: false, leader: false, nanoCpus: 1, memoryBytes: 1, labels: {} },
    serviceIds: ['svc'], tasks: [],
  };
  const nodePlan: NodeMutationPlan & { targetLabels: Record<string, string> } = {
    nodeId: 'node', version: 1, beforeSpecHash: 'node-before', targetSpecHash: 'node-after',
    targetAvailability: action === 'drain' ? 'drain' : 'active', affectedServiceIds: ['svc'],
    targetLabels: { zone: 'new' },
  };
  const nodeAfter: NodeDetailResponse = { ...nodeBefore,
    node: { ...nodeBefore.node, version: 2, specHash: 'node-after',
      availability: nodePlan.targetAvailability, labels: nodePlan.targetLabels } };

  let saved: { services: Map<string, OperationRecord>; nodes: Map<string, NodeOperationRecord>;
    deployments: Map<string, DeploymentRecord>; audits: AuditEventInput[] } | null = null;
  function restore<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear();
    for (const [id, row] of source) target.set(id, copy(row));
  }
  const connection = {
    async beginTransaction() {
      assert.equal(saved, null, 'nested transaction');
      saved = copy({ services: serviceRows, nodes: nodeRows, deployments: deploymentRows, audits: audit });
    },
    async commit() { assert.ok(saved); saved = null; },
    async rollback() {
      assert.ok(saved);
      restore(serviceRows, saved.services); restore(nodeRows, saved.nodes);
      restore(deploymentRows, saved.deployments); audit.splice(0, audit.length, ...saved.audits);
      saved = null; state.rollbackCalls++;
    },
  } as PoolConnection;
  const setService = (id: string, status: OperationStatus, code: string | null = null, message: string | null = null) => {
    Object.assign(serviceRows.get(id)!, { status, errorCode: code, errorMessage: message });
  };
  const setNode = (id: string, status: OperationStatus, code: string | null = null, message: string | null = null) => {
    Object.assign(nodeRows.get(id)!, { status, errorCode: code, errorMessage: message });
  };
  const operationRepository = {
    async find(id: string) { return copy(serviceRows.get(id) ?? null); },
    async findWithConnection(_c: PoolConnection, id: string) { return this.find(id); },
    async listNonTerminal() { return copy([...serviceRows.values()].filter((row) => !terminal(row))); },
    async findNonTerminalForServiceWithConnection(_c: PoolConnection, c: string, id: string) {
      return copy([...serviceRows.values()].find((row) => row.clusterId === c && row.serviceId === id && !terminal(row)) ?? null);
    },
    async create(_c: PoolConnection, input: Parameters<OperationRepository['create']>[1]) {
      assert.equal(serviceRows.has(input.id), false);
      serviceRows.set(input.id, { ...input, targetReplicas: input.targetReplicas ?? null,
        status: 'PENDING', resultVersion: null, errorCode: null, errorMessage: null,
        createdAt: timestamp, updatedAt: timestamp });
    },
    async markRunning(_c: PoolConnection, id: string) { setService(id, 'RUNNING'); },
    async markVerifying(_c: PoolConnection, id: string, version: number) {
      setService(id, 'VERIFYING'); serviceRows.get(id)!.resultVersion = version;
    },
    async markVerificationPending(_c: PoolConnection, id: string, code: string, message: string) {
      setService(id, 'VERIFYING', code, message);
    },
    async markSuccess(_c: PoolConnection, id: string, version: number) {
      setService(id, 'SUCCESS'); serviceRows.get(id)!.resultVersion = version;
    },
    async markFailed(_c: PoolConnection, id: string, code: string, message: string) { setService(id, 'FAILED', code, message); },
    async markNeedsAttention(_c: PoolConnection, id: string, code: string, message: string) { setService(id, 'NEEDS_ATTENTION', code, message); },
    async audit(_c: PoolConnection, event: AuditEventInput) {
      if (state.failRejectionAudit && !event.action.endsWith('_STARTED')) throw new Error('audit unavailable');
      audit.push(copy(event));
    },
  };
  const nodeRepository = {
    async find(id: string) { return copy(nodeRows.get(id) ?? null); },
    async findWithConnection(_c: PoolConnection, id: string) { return this.find(id); },
    async listNonTerminal() { return copy([...nodeRows.values()].filter((row) => !terminal(row))); },
    async findNonTerminalForNode(c: string, id: string) {
      return copy([...nodeRows.values()].find((row) => row.clusterId === c && row.nodeId === id && !terminal(row)) ?? null);
    },
    async findNonTerminalForNodeWithConnection(_c: PoolConnection, c: string, id: string) { return this.findNonTerminalForNode(c, id); },
    async findNonTerminalAffectingServiceWithConnection(_c: PoolConnection, c: string, id: string) {
      return copy([...nodeRows.values()].find((row) => row.clusterId === c && row.affectedServiceIds.includes(id) && !terminal(row)) ?? null);
    },
    async create(_c: PoolConnection, input: Parameters<NodeOperationRepository['create']>[1]) {
      assert.equal(nodeRows.has(input.id), false);
      nodeRows.set(input.id, { ...input, targetLabels: input.targetLabels ?? null,
        labelPatch: input.labelPatch ?? null, status: 'PENDING', resultVersion: null,
        errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp });
    },
    async markRunning(_c: PoolConnection, id: string) { setNode(id, 'RUNNING'); },
    async markVerifying(_c: PoolConnection, id: string, version: number) {
      setNode(id, 'VERIFYING'); nodeRows.get(id)!.resultVersion = version;
    },
    async markSuccess(_c: PoolConnection, id: string, version: number) {
      setNode(id, 'SUCCESS'); nodeRows.get(id)!.resultVersion = version;
    },
    async markFailed(_c: PoolConnection, id: string, code: string, message: string) { setNode(id, 'FAILED', code, message); },
    async markNeedsAttention(_c: PoolConnection, id: string, code: string, message: string) { setNode(id, 'NEEDS_ATTENTION', code, message); },
  };
  function deploymentStatus(id: string, status: DeploymentStatus, reason: string | null = null): void {
    Object.assign(deploymentRows.get(id)!, { status, reason });
  }
  const deploymentRepository = {
    async find(id: string) { return copy(deploymentRows.get(id) ?? null); },
    async requireWithConnection(_c: PoolConnection, id: string) { assert.ok(deploymentRows.has(id)); return copy(deploymentRows.get(id)!); },
    async findByOperation(id: string) { return copy([...deploymentRows.values()].find((row) => row.operationId === id) ?? null); },
    async findByOperationWithConnection(_c: PoolConnection, id: string) { return this.findByOperation(id); },
    async findByRollbackOperationWithConnection(_c: PoolConnection, id: string) {
      return copy([...deploymentRows.values()].find((row) => row.rollbackOperationId === id) ?? null);
    },
    async findLatestSuccessfulForReleaseWithConnection() { return { id: 'historical-source' }; },
    async latestSuccessfulReleaseId() { return 'old-release'; },
    async create(_c: PoolConnection, input: Parameters<DeploymentRepository['create']>[1]) {
      const row: DeploymentRecord = { ...input, kind: input.kind ?? 'DEPLOY',
        sourceDeploymentId: input.sourceDeploymentId ?? null, id: `deployment-${input.operationId}`,
        rollbackOperationId: null, reason: null, startedAt: timestamp, finishedAt: null, createdAt: timestamp };
      deploymentRows.set(row.id, copy(row)); return copy(row);
    },
    async markRollingBack(_c: PoolConnection, id: string, operationId: string) {
      deploymentStatus(id, 'ROLLING_BACK'); deploymentRows.get(id)!.rollbackOperationId = operationId;
    },
    async markFailed(_c: PoolConnection, id: string, message: string) { deploymentStatus(id, 'FAILED', message); },
    async markRollbackFailed(_c: PoolConnection, id: string, message: string) { deploymentStatus(id, 'ROLLBACK_FAILED', message); },
    async markNeedsAttention(_c: PoolConnection, id: string, message: string) { deploymentStatus(id, 'NEEDS_ATTENTION', message); },
    async markVerificationPending(_c: PoolConnection, id: string, message: string) { deploymentStatus(id, 'VERIFYING', message); },
    async markRollbackVerificationPending(_c: PoolConnection, id: string, message: string) { deploymentStatus(id, 'ROLLBACK_VERIFYING', message); },
    async markVerifying(_c: PoolConnection, id: string) { deploymentStatus(id, 'VERIFYING'); },
    async markRollbackVerifying(_c: PoolConnection, id: string) { deploymentStatus(id, 'ROLLBACK_VERIFYING'); },
    async markSuccess(_c: PoolConnection, id: string) { deploymentStatus(id, 'SUCCESS'); },
    async markRolledBack(_c: PoolConnection, id: string) { deploymentStatus(id, 'ROLLED_BACK'); },
  };
  if (action === 'rollback') {
    deploymentRows.set('failed-deployment', {
      id: 'failed-deployment', kind: 'DEPLOY', sourceDeploymentId: null, releaseId: 'new-release',
      previousReleaseId: 'old-release', deploymentTargetId: 'target', operationId: 'previous-deploy',
      rollbackOperationId: null, status: 'FAILED', reason: 'previous deployment failed', noOp: false,
      beforeSpec: { specHash: 'after' }, targetSpec: { specHash: 'before' }, health,
      expectedServiceVersion: 1, startedAt: timestamp, finishedAt: timestamp,
      createdBy: principal.actorId, createdAt: timestamp,
    });
  }
  const releases = {
    async findDeploymentTarget() { return { id: 'target', clusterId: cluster, applicationId: 'app', dockerServiceId: 'svc' }; },
    async findRelease(id: string) { return { id, applicationId: 'app', imageRepository: 'repo', imageDigest: id === 'old-release' ? oldDigest : newDigest }; },
  };
  const planCall = async <T>(value: T): Promise<T> => {
    state.plans++;
    if (state.planError) throw state.planError;
    return copy(value);
  };
  const send = async () => {
    state.sends++;
    if (!state.error || state.applyBeforeError) state.applied = true;
    if (state.error) throw state.error;
  };
  const serviceSend = async () => {
    await send(); return { serviceId: 'svc', version: 2, targetSpecHash: 'after', targetForceUpdate: plan.targetForceUpdate };
  };
  const nodeSend = async () => {
    await send(); return { nodeId: 'node', version: 2, targetSpecHash: 'node-after',
      targetAvailability: nodePlan.targetAvailability as 'active' | 'drain' };
  };
  const agent: Partial<AgentClient> = {
    inspectService: async () => { state.reads++; return copy(state.applied ? after : before); },
    inspectNode: async () => { state.reads++; return copy(state.applied ? nodeAfter : nodeBefore); },
    planScaleService: () => planCall(plan), planRestartService: () => planCall(plan),
    planUpdateServiceImage: () => planCall(plan), planRollbackService: () => planCall(plan),
    planDrainNode: () => planCall(nodePlan), planActivateNode: () => planCall(nodePlan), planNodeLabels: () => planCall(nodePlan),
    scaleService: serviceSend, restartService: serviceSend, updateServiceImage: serviceSend, rollbackService: serviceSend,
    drainNode: nodeSend, activateNode: nodeSend, updateNodeLabels: nodeSend,
    checkServicePlacement: async () => ({ status: 'CONVERGED', serviceId: 'svc',
      desiredReplicas: 1, runningReplicas: 1, reasons: [], unsupportedConstraints: [], violations: [] }),
  };
  const lock = {
    withServiceLock: async (_c: string, _s: string, work: (c: PoolConnection) => Promise<unknown>) => work(connection),
    withNodeAndServiceLocks: async (_c: string, _n: string, _s: string[], work: (c: PoolConnection) => Promise<unknown>) => work(connection),
  } as unknown as OperationLock;
  const capacity = { assertAvailable: async () => {} } as unknown as CapacityService;
  const healthVerifier = { verify: async (_h: unknown, check: () => Promise<void>) => check() } as unknown as HealthVerifier;
  function coordinators() {
    const service = new MutationService(agent as AgentClient, operationRepository as unknown as OperationRepository,
      nodeRepository as unknown as NodeOperationRepository, lock, capacity);
    const node = new NodeMutationService(agent as AgentClient, nodeRepository as unknown as NodeOperationRepository,
      operationRepository as unknown as OperationRepository, lock);
    const deployment = new DeploymentService(releases as unknown as ReleaseRepository,
      deploymentRepository as unknown as DeploymentRepository, agent as AgentClient,
      operationRepository as unknown as OperationRepository, nodeRepository as unknown as NodeOperationRepository,
      lock, capacity, healthVerifier);
    return { service, node, deployment };
  }
  const invoke = (c: ReturnType<typeof coordinators>, operationId = 'op') => {
    if (action === 'scale') return c.service.scale(cluster, 'svc', { operationId, expectedVersion: 1, replicas: 2 }, principal);
    if (action === 'restart') return c.service.restart(cluster, 'svc', { operationId, expectedVersion: 1 }, principal);
    if (action === 'labels') return c.node.labels(cluster, 'node', { operationId, expectedVersion: 1, set: { zone: 'new' }, remove: [] }, principal);
    if (action === 'drain' || action === 'activate') return c.node[action](cluster, 'node', { operationId, expectedVersion: 1 }, principal);
    if (action === 'rollback') return c.deployment.rollback(cluster, 'failed-deployment', { operationId }, principal);
    return c.deployment[action === 'historical' ? 'historicalRedeploy' : 'deploy'](
      cluster, 'target', { operationId, releaseId: 'new-release', health }, principal);
  };
  const record = () => copy(serviceRows.get('op') ?? nodeRows.get('op'));
  return { state, agent, audit, serviceRows, nodeRows, deploymentRows, record, coordinators, invoke };
}

function skipObservationWait(t: TestContext): void {
  // No wall-clock polling in rejection tests. Target-observed tests below use
  // real clocks and actual convergence methods instead.
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 60_000));
}

for (const action of actions) {
  test(`${action}: definite rejections terminate, survive coordinator restart and release conflicts`, async (t) => {
    for (const [status, code] of [...guardErrors, [400, 'legacy'], [409, 'legacy']] as Array<readonly [number, string]>) {
      await t.test(`${status}/${code}`, async (t) => {
        skipObservationWait(t);
        const error = new AgentRequestError(status, JSON.stringify({ code, error: 'rejected before dispatch' }));
        const f = fixture(action, error);
        await assert.rejects(f.invoke(f.coordinators()));
        assert.equal(f.record()?.status, 'FAILED');
        assert.equal(f.record()?.errorMessage, error.responseBody);
        assert.equal(f.state.applied, false);
        assert.equal(f.state.sends, 1);
        assert.equal(f.audit.length, 2, 'intent and rejection each audited once');
        if (action === 'rollback') assert.equal(f.deploymentRows.get('failed-deployment')?.status, 'FAILED');
        const fresh = f.coordinators();
        await fresh.service.onApplicationBootstrap();
        await fresh.node.onApplicationBootstrap();
        try { await fresh.deployment.onApplicationBootstrap(); }
        finally { fresh.deployment.onApplicationShutdown(); }
        await f.invoke(fresh); // Same ID returns terminal state, no replay or new audit.
        assert.equal(f.state.sends, 1);
        assert.equal(f.audit.length, 2);
        f.state.planError = new Error('next planning reached');
        await assert.rejects(fresh.service.scale(cluster, 'svc',
          { operationId: 'next', expectedVersion: 1, replicas: 2 }, principal), /next planning reached/);
        await assert.rejects(f.invoke(fresh, 'next-same-kind'), /next planning reached/);
        assert.equal(f.state.sends, 1);
      });
    }
  });

  test(`${action}: ambiguous responses keep mutation protection and are never resent`, async (t) => {
    for (const error of [new AgentRequestError(503, '{"error":"upstream unavailable"}'),
      new AgentRequestError(503, '{"code":"CLUSTER_PRECONDITION_FAILED"}'),
      new Error('response lost')]) {
      await t.test(error.message + (error instanceof AgentRequestError ? error.responseBody : ''), async (t) => {
        skipObservationWait(t);
        const f = fixture(action, error);
        await f.invoke(f.coordinators());
        assert.ok(f.record()); assert.equal(terminal(f.record()!), false);
        const fresh = f.coordinators();
        await fresh.service.onApplicationBootstrap();
        await fresh.node.onApplicationBootstrap();
        try { await fresh.deployment.onApplicationBootstrap(); }
        finally { fresh.deployment.onApplicationShutdown(); }
        await assert.rejects(fresh.service.scale(cluster, 'svc',
          { operationId: 'next', expectedVersion: 1, replicas: 2 }, principal),
        (e: unknown) => e instanceof Error && 'getStatus' in e && (e as { getStatus(): number }).getStatus() === 409);
        assert.equal(f.state.sends, 1);
      });
    }
  });
}

test('lost response after application still reconciles to success without replay for every mutation', async (t) => {
  for (const action of actions) {
    await t.test(action, async () => {
      const f = fixture(action, new AgentRequestError(503, '{"error":"response unavailable after update"}'));
      f.state.applyBeforeError = true;
      await f.invoke(f.coordinators());
      assert.equal(f.record()?.status, 'SUCCESS');
      assert.equal(f.state.sends, 1);
      assert.equal(f.state.applied, true);
    });
  }
});

test('rejection persistence and audit remain atomic across all coordinator types', async (t) => {
  for (const action of ['scale', 'labels', 'deploy', 'rollback'] as const) {
    await t.test(action, async (t) => {
      skipObservationWait(t);
      const f = fixture(action, new AgentRequestError(412, '{"code":"CLUSTER_PRECONDITION_FAILED"}'));
      f.state.failRejectionAudit = true;
      await assert.rejects(f.invoke(f.coordinators()), /audit unavailable/);
      assert.equal(f.record()?.status, 'RUNNING', 'uncommitted rejection must not release the resource');
      assert.equal(f.audit.length, 1);
      assert.equal(f.state.rollbackCalls, 1);
      assert.equal(f.state.sends, 1);
    });
  }
});

test('a real rollback convergence failure remains protected, unlike a pre-dispatch rejection', async () => {
  const f = fixture('rollback', null);
  const inspect = f.agent.inspectService!;
  f.agent.inspectService = async (id) => {
    const value = await inspect(id);
    if (f.state.applied) value.service.updateState = 'rollback_paused';
    return value;
  };
  await f.invoke(f.coordinators());
  assert.equal(f.record()?.status, 'NEEDS_ATTENTION');
  assert.equal(f.deploymentRows.get('failed-deployment')?.status, 'ROLLBACK_FAILED');
  assert.equal(f.state.sends, 1);
});

test('old uncertain records without a persisted rejection are not retroactively released', async () => {
  const f = fixture('scale', new Error('Agent request failed with 412'));
  await f.invoke(f.coordinators());
  const fresh = f.coordinators();
  await fresh.service.onApplicationBootstrap();
  assert.equal(f.record()?.status, 'NEEDS_ATTENTION');
  assert.equal(f.record()?.errorCode, 'MUTATION_NOT_OBSERVED');
  assert.equal(f.state.sends, 1);
});

test('a later read rejection cannot prove that a previously sent mutation did not run', async (t) => {
  for (const action of ['scale', 'labels', 'deploy', 'rollback'] as const) {
    await t.test(action, async (t) => {
      skipObservationWait(t);
      const f = fixture(action, new Error('mutation response lost'));
      await f.invoke(f.coordinators());
      const deniedRead = async () => { throw new AgentRequestError(503, '{"code":"CLUSTER_IDENTITY_UNAVAILABLE"}'); };
      f.agent.inspectService = deniedRead;
      f.agent.inspectNode = deniedRead;
      const fresh = f.coordinators();
      await fresh.service.onApplicationBootstrap();
      await fresh.node.onApplicationBootstrap();
      try { await fresh.deployment.onApplicationBootstrap(); }
      finally { fresh.deployment.onApplicationShutdown(); }
      assert.ok(f.record());
      assert.equal(terminal(f.record()!), false);
      assert.equal(f.state.sends, 1);
    });
  }
});
