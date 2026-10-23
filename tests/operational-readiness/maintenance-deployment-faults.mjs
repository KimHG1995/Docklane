import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createPostApplyResponseLossProxy } from './maintenance-response-loss-proxy.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function assertWorkloadSnapshot(snapshot, replicas, image) {
  assert.ok(Number.isInteger(replicas) && replicas > 0, 'acceptance requires nonempty workload');
  assert.match(image, /^.+@sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.service.desiredReplicas, replicas);
  assert.equal(snapshot.service.runningReplicas, replicas);
  assert.equal(snapshot.service.image, image);
  const running = snapshot.tasks.filter(task => task.state === 'running' && task.desiredState === 'running');
  assert.equal(running.length, replicas, 'must observe actual running workload, not merely desired replicas');
  assert.equal(new Set(running.map(task => task.slot)).size, replicas, 'running slots must be distinct');
  for (const task of running) {
    assert.ok(task.slot > 0);
    assert.equal(task.image, image, 'every running task must use the pinned target image');
  }
}

export function assertSingleMutation(events, expectedPath) {
  // Count every relay event: a rejected replay (409/412) is still a replay.
  assert.equal(events.length, 1, 'exactly one mutation attempt, including rejected attempts');
  assert.equal(events[0].method, 'POST');
  assert.equal(events[0].path, expectedPath);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].acknowledgedByAgent, true);
}

export async function settleCleanup(actions, timeoutMs = 5000) {
  const results = await Promise.allSettled(actions.map(async action => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timed out')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }));
  return results.filter(result => result.status === 'rejected').map(result => result.reason);
}

async function waitWorkload(raw, serviceId, replicas, image) {
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const snapshot = await raw.inspectService(serviceId);
      assertWorkloadSnapshot(snapshot, replicas, image);
      assert.equal((await raw.checkServicePlacement(serviceId)).status, 'CONVERGED');
      return snapshot;
    } catch (error) { lastError = error; }
    await pause(500);
  }
  throw new Error(`Owned deployment workload did not converge: ${lastError}`);
}

/**
 * Real MySQL + Docker acceptance of DeploymentService, not a mock coordinator.
 * Call while maintenance is OPEN, after tests that require zero unresolved
 * dispatches. Original UNCERTAIN rows and all operation/deployment/audit records
 * are intentionally retained until the owning harness destroys its database.
 * @param {{db: any, registry: any, containers: Record<string, string>, docker: (...args: string[]) => string, cert: Buffer, key: Buffer, ca: Buffer, evidence?: Record<string, any>}} context
 * HealthVerifier uses a controlled loopback HTTP fixture; Docker task/placement
 * convergence is checked independently and is never inferred from that fixture.
 */
export async function runDeploymentFaultAcceptance({ db, registry, containers, docker, cert, key, ca, evidence = {} }) {
  const { HttpAgentClient } = await import('../../apps/api/dist/agent/http-agent.client.js');
  const { withMutationOperation } = await import('../../apps/api/dist/agent/mutation-dispatch-context.js');
  const { AuditRepository } = await import('../../apps/api/dist/audit/audit.repository.js');
  const { CapacityService } = await import('../../apps/api/dist/capacity/capacity.service.js');
  const { ClusterRegistrationRepository } = await import('../../apps/api/dist/clusters/cluster-registration.repository.js');
  const { ClusterBindingPolicy } = await import('../../apps/api/dist/clusters/cluster-binding.policy.js');
  const { MaintenanceDispatchJournal } = await import('../../apps/api/dist/clusters/maintenance-dispatch-journal.js');
  const { registeredAgentClient } = await import('../../apps/api/dist/clusters/registered-agent-client.js');
  const { RegisteredOperationLock } = await import('../../apps/api/dist/clusters/registered-operation-lock.js');
  const { DeploymentRepository } = await import('../../apps/api/dist/deployments/deployment.repository.js');
  const { DeploymentService } = await import('../../apps/api/dist/deployments/deployment.service.js');
  const { HealthEndpointPolicy } = await import('../../apps/api/dist/deployments/health-endpoint.policy.js');
  const { HealthVerifier } = await import('../../apps/api/dist/deployments/health-verifier.js');
  const { OperationRepository } = await import('../../apps/api/dist/operations/operation.repository.js');
  const { NodeOperationRepository } = await import('../../apps/api/dist/operations/node-operation.repository.js');
  const { ReleaseRepository } = await import('../../apps/api/dist/releases/release.repository.js');
  assert.equal(process.env.DOCKLANE_MAINTENANCE_ENFORCE, '1');
  assert.ok(registry.expectedClusterId);
  const manager = containers['manager-01'];
  assert.ok(manager);
  Object.assign(evidence, { serviceId: null, workload: null, baseline: null, deployResponseLoss: null, rollbackResponseLoss: null });
  const suffix = randomUUID().slice(0, 8);
  const serviceName = `docklane-deploy-fault-${suffix}`;
  const actorId = `acceptance-deploy-${suffix}`;
  /** @type {import('../../apps/api/dist/auth/auth.types.js').Principal} */
  const principal = { actorId, role: 'ADMIN', clusters: ['default'] };
  const registrations = new ClusterRegistrationRepository(db);
  const policy = new ClusterBindingPolicy(registrations, {
    mode: 'enforce', logicalClusterId: 'default', expectedSwarmClusterId: registry.expectedClusterId,
  });
  const journal = new MaintenanceDispatchJournal(db);
  const raw = new HttpAgentClient(registry, journal);
  const guarded = registeredAgentClient(raw, policy, db);
  const lock = new RegisteredOperationLock(db, policy);
  const operations = new OperationRepository(db);
  const nodeOperations = new NodeOperationRepository(db);
  const deployments = new DeploymentRepository(db);
  const releases = new ReleaseRepository(db, new AuditRepository());
  let healthy = true;
  const healthServer = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(healthy ? 'acceptance health fixture ready' : 'injected application health failure');
  });
  let serviceId;
  let healthStarted = false;
  const oldPrivateHosts = process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
  const services = [];
  const proxies = [];
  let primaryFailure = false;
  try {
    await new Promise((resolve, reject) => {
      healthServer.once('error', reject);
      healthServer.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    healthStarted = true;
    const address = healthServer.address();
    assert.ok(address && typeof address !== 'string');
    const host = `127.0.0.1:${address.port}`;
    process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS = [oldPrivateHosts, host].filter(Boolean).join(',');
    const healthVerifier = new HealthVerifier(new HealthEndpointPolicy());
    const health = { url: `http://${host}/health`, intervalMs: 100, timeoutMs: 1000, retries: 0, stabilityWindowMs: 500, expectedStatus: 200 };
    const coordinator = agent => {
      const result = new DeploymentService(releases, deployments, agent, operations, nodeOperations,
        lock, new CapacityService(agent), healthVerifier);
      services.push(result);
      return result;
    };
    const normal = coordinator(guarded);
    const images = ['alpine:3.20', 'alpine:3.21'].map(tag => {
      docker('exec', manager, 'docker', 'pull', tag);
      const pinned = docker('exec', manager, 'docker', 'image', 'inspect', tag, '--format', '{{index .RepoDigests 0}}');
      assert.match(pinned, /^alpine@sha256:[a-f0-9]{64}$/);
      return pinned;
    });
    assert.notEqual(images[0], images[1], 'fault acceptance requires two distinct immutable images');
    for (const container of Object.values(containers)) {
      for (const image of images) docker('exec', container, 'docker', 'pull', image);
    }
    serviceId = docker('exec', manager, 'docker', 'service', 'create', '--detach=true', '--no-resolve-image',
      '--name', serviceName, '--replicas', '1', '--reserve-memory', '16M', '--reserve-cpu', '0.01',
      '--update-order', 'start-first', '--update-parallelism', '1', '--update-monitor', '1s',
      '--rollback-order', 'start-first', '--rollback-monitor', '1s', images[0], 'sleep', '3600').split('\n').at(-1);
    assert.match(serviceId, /^[0-9a-z]{12,}$/);
    evidence.serviceId = serviceId;
    const one = await waitWorkload(raw, serviceId, 1, images[0]);
    const scalePlan = await raw.planScaleService(serviceId, one.service.version, 2);
    const scaleOperationId = `workload-scale-${randomUUID()}`;
    await lock.withServiceLock('default', serviceId, () => withMutationOperation(scaleOperationId, () => guarded.scaleService(serviceId, {
      expectedVersion: scalePlan.version, expectedSpecHash: scalePlan.beforeSpecHash,
      targetSpecHash: scalePlan.targetSpecHash, replicas: 2,
    })));
    const two = await waitWorkload(raw, serviceId, 2, images[0]);
    assert.ok(two.service.version > one.service.version);
    evidence.workload = { operationId: scaleOperationId, beforeReplicas: 1, afterReplicas: 2,
      runningReplicas: two.service.runningReplicas, runningSlots: two.tasks.filter(t => t.state === 'running' && t.desiredState === 'running').map(t => t.slot),
      placement: 'CONVERGED', image: images[0] };

    const application = await releases.createApplication({ name: serviceName }, actorId);
    const target = await releases.createDeploymentTarget(application.id, 'default', {
      environment: `acceptance-${suffix}`, dockerServiceId: serviceId, serviceName, routingMode: 'INGRESS',
    }, actorId);
    const releaseA = await releases.createRelease(application.id, { version: `a-${suffix}`, imageRepository: 'alpine', imageDigest: images[0].split('@')[1] }, actorId);
    const releaseB = await releases.createRelease(application.id, { version: `b-${suffix}`, imageRepository: 'alpine', imageDigest: images[1].split('@')[1] }, actorId);
    const baselineInput = { operationId: `deploy-base-${randomUUID()}`, releaseId: releaseA.id, health };
    const baseline = await normal.deploy('default', target.id, baselineInput, principal);
    assert.equal(baseline.status, 'SUCCESS');
    assert.equal((await operations.find(baselineInput.operationId)).status, 'SUCCESS');
    evidence.baseline = { applicationId: application.id, targetId: target.id, releaseId: releaseA.id, deploymentId: baseline.id, status: baseline.status };

    async function lossCoordinator(id) {
      const proxy = await createPostApplyResponseLossProxy({ targetUrl: registry.agents[0].baseUrl, cert, key, ca });
      proxies.push(proxy);
      const client = new HttpAgentClient({ primaryId: id, expectedClusterId: registry.expectedClusterId,
        agents: [{ id, baseUrl: proxy.baseUrl, insecureDev: true }] }, journal);
      return { proxy, service: coordinator(registeredAgentClient(client, policy, db)) };
    }
    async function recordDispatch(operationId, proxy, route) {
      const [rows] = await db.query('SELECT id, phase FROM maintenance_dispatches WHERE operation_id = ?', [operationId]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].phase, 'UNCERTAIN');
      assertSingleMutation(proxy.events, `/v2/services/${serviceId}/${route}`);
      return { evidenceId: rows[0].id, phase: rows[0].phase, agentMutationCount: proxy.events.length };
    }
    async function requireAudit(operationId, action) {
      const [rows] = await db.query('SELECT action FROM audit_events WHERE operation_id = ? AND action = ?', [operationId, action]);
      assert.equal(rows.length, 1, `one ${action} audit must persist`);
    }

    const deployLoss = await lossCoordinator('deployment-loss');
    const deployInput = { operationId: `deploy-loss-${randomUUID()}`, releaseId: releaseB.id, health };
    const deployed = await deployLoss.service.deploy('default', target.id, deployInput, principal);
    assert.equal(deployed.status, 'SUCCESS', 'observed real convergence must complete the lost-response deployment');
    assert.equal(deployed.previousReleaseId, releaseA.id);
    assert.equal((await operations.find(deployInput.operationId)).status, 'SUCCESS');
    await requireAudit(deployInput.operationId, 'DEPLOY_SUCCEEDED');
    const deployedSnapshot = await waitWorkload(raw, serviceId, 2, images[1]);
    const deploymentDispatch = await recordDispatch(deployInput.operationId, deployLoss.proxy, 'image');
    const deploymentRetry = await deployLoss.service.deploy('default', target.id, deployInput, principal);
    assert.equal(deploymentRetry.id, deployed.id);
    assert.equal(deploymentRetry.status, 'SUCCESS');
    // Bootstrap reconciliation must not replay the already completed operation.
    await deployLoss.service.onApplicationBootstrap();
    deployLoss.service.onApplicationShutdown();
    assert.equal((await raw.inspectService(serviceId)).service.version, deployedSnapshot.service.version);
    await recordDispatch(deployInput.operationId, deployLoss.proxy, 'image');
    evidence.deployResponseLoss = { deploymentId: deployed.id, operationId: deployInput.operationId,
      deploymentStatus: deployed.status, operationStatus: 'SUCCESS', ...deploymentDispatch,
      versionAfter: deployedSnapshot.service.version, retryPreservedVersion: true, bootstrapReplayAbsent: true };

    // Persist a real FAILED deployment through the actual health failure path.
    // Do not fabricate FAILED rows just to make the rollback endpoint eligible.
    healthy = false;
    const failedInput = { operationId: `deploy-fail-${randomUUID()}`, releaseId: releaseA.id, health };
    const failed = await normal.deploy('default', target.id, failedInput, principal);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.previousReleaseId, releaseB.id);
    const failedOperation = await operations.find(failedInput.operationId);
    assert.equal(failedOperation.status, 'FAILED');
    assert.equal(failedOperation.errorCode, 'HEALTH_VERIFICATION_FAILED');
    await requireAudit(failedInput.operationId, 'DEPLOY_FAILED');
    await waitWorkload(raw, serviceId, 2, images[0]);
    healthy = true;
    const rollbackLoss = await lossCoordinator('rollback-deployment-loss');
    const rollbackInput = { operationId: `rollback-loss-${randomUUID()}` };
    const rolledBack = await rollbackLoss.service.rollback('default', failed.id, rollbackInput, principal);
    assert.equal(rolledBack.status, 'ROLLED_BACK');
    assert.equal(rolledBack.rollbackOperationId, rollbackInput.operationId);
    assert.equal((await operations.find(rollbackInput.operationId)).status, 'SUCCESS');
    assert.equal((await deployments.findByRollbackOperation(rollbackInput.operationId)).id, failed.id);
    await requireAudit(rollbackInput.operationId, 'ROLLBACK_SUCCEEDED');
    const rollbackSnapshot = await waitWorkload(raw, serviceId, 2, images[1]);
    const rollbackDispatch = await recordDispatch(rollbackInput.operationId, rollbackLoss.proxy, 'rollback');
    const rollbackRetry = await rollbackLoss.service.rollback('default', failed.id, rollbackInput, principal);
    assert.equal(rollbackRetry.status, 'ROLLED_BACK');
    await rollbackLoss.service.onApplicationBootstrap();
    rollbackLoss.service.onApplicationShutdown();
    assert.equal((await raw.inspectService(serviceId)).service.version, rollbackSnapshot.service.version);
    await recordDispatch(rollbackInput.operationId, rollbackLoss.proxy, 'rollback');
    evidence.rollbackResponseLoss = { deploymentId: failed.id, failedDeployOperationId: failedInput.operationId,
      operationId: rollbackInput.operationId, deploymentStatus: rolledBack.status, operationStatus: 'SUCCESS',
      ...rollbackDispatch, versionAfter: rollbackSnapshot.service.version, retryPreservedVersion: true, bootstrapReplayAbsent: true };
    evidence.healthScope = 'real HealthVerifier with injected loopback HTTP fixture; actual Docker workload and placement checked separately';
    return evidence;
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupErrors = await settleCleanup([
      ...services.map(service => () => service.onApplicationShutdown()),
      ...proxies.map(proxy => () => proxy.close()),
      () => healthStarted ? new Promise((resolve, reject) => {
        healthServer.close(error => error ? reject(error) : resolve(undefined));
        healthServer.closeAllConnections();
      }) : undefined,
      () => {
        if (oldPrivateHosts === undefined) delete process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS;
        else process.env.DOCKLANE_HEALTH_PRIVATE_HOSTS = oldPrivateHosts;
      },
      () => { if (serviceId) docker('exec', manager, 'docker', 'service', 'rm', serviceId); },
    ]);
    if (cleanupErrors.length) {
      evidence.cleanupErrors = cleanupErrors.map(error => String(error));
      if (!primaryFailure) throw new AggregateError(cleanupErrors, 'Deployment acceptance cleanup failed');
    }
  }
}
