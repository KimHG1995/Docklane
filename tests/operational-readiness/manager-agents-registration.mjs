import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { HttpAgentClient } from '../../apps/api/dist/agent/http-agent.client.js';
import { Database } from '../../apps/api/dist/db/database.js';
import { ClusterRegistrationRepository } from '../../apps/api/dist/clusters/cluster-registration.repository.js';
import {
  ClusterBindingPolicy,
  loadClusterBindingSettings,
} from '../../apps/api/dist/clusters/cluster-binding.policy.js';
import { registeredAgentClient } from '../../apps/api/dist/clusters/registered-agent-client.js';

const definitions = JSON.parse(process.env.DOCKLANE_MANAGER_AGENT_URLS);
const ca = readFileSync(process.env.DOCKLANE_AGENT_CA_FILE);
const cert = readFileSync(process.env.DOCKLANE_AGENT_CERT_FILE);
const key = readFileSync(process.env.DOCKLANE_AGENT_KEY_FILE);
const registry = {
  primaryId: 'manager-01',
  expectedClusterId: process.env.DOCKLANE_EXPECTED_CLUSTER_ID,
  agents: definitions.map((definition) => ({
    ...definition,
    insecureDev: false,
    ca,
    cert,
    key,
  })),
};
const settings = loadClusterBindingSettings();
assert.equal(settings.mode, 'enforce');
assert.equal(settings.logicalClusterId, 'default');
assert.equal(settings.expectedSwarmClusterId, registry.expectedClusterId);

const db = new Database();
try {
  await db.onModuleInit();
  const registrations = new ClusterRegistrationRepository(db);
  const policy = new ClusterBindingPolicy(registrations, settings);
  const raw = new HttpAgentClient(registry);
  const guarded = registeredAgentClient(raw, policy);
  const rejection = (code) => (error) => {
    assert.equal(error?.getStatus?.(), 503);
    assert.equal(error?.getResponse?.()?.code, code);
    return true;
  };

  await assert.rejects(guarded.identity(), rejection('CLUSTER_REGISTRATION_REQUIRED'));
  const initial = await raw.identity();
  assert.equal(initial.hostname, 'manager-01');
  assert.equal(initial.clusterId, settings.expectedSwarmClusterId);

  const registration = await registrations.register({
    clusterId: settings.logicalClusterId,
    swarmClusterId: settings.expectedSwarmClusterId,
    displayName: 'disposable-three-manager-poc',
    registeredBy: 'operational-acceptance-admin',
    verifiedNodeId: initial.nodeId,
  });
  const replay = await registrations.register({
    clusterId: settings.logicalClusterId,
    swarmClusterId: settings.expectedSwarmClusterId,
    displayName: 'disposable-three-manager-poc',
    registeredBy: 'second-operational-admin',
    verifiedNodeId: initial.nodeId,
  });
  assert.deepEqual(replay, registration);
  const before = await guarded.identity();
  assert.equal(before.hostname, 'manager-01');
  assert.equal(before.clusterId, registration.swarmClusterId);

  const [auditRows] = await db.query(
    "SELECT COUNT(*) AS count FROM audit_events WHERE operation_id = ? AND action = 'CLUSTER_REGISTERED'",
    [registration.id],
  );
  assert.equal(Number(auditRows[0].count), 1);

  const mismatched = registeredAgentClient(raw, new ClusterBindingPolicy(registrations, {
    ...settings,
    expectedSwarmClusterId: 'different-swarm-id',
  }));
  await assert.rejects(mismatched.identity(), rejection('CLUSTER_REGISTRATION_MISMATCH'));

  execFileSync('docker', [
    'exec',
    process.env.DOCKLANE_MANAGER_01_CONTAINER,
    'sh',
    '-c',
    'pid="$(pidof docklane-agent)" && test -n "$pid" && kill "$pid" && sleep 1 && ! pidof docklane-agent',
  ], { stdio: 'inherit' });

  const after = await guarded.identity();
  assert.equal(after.clusterId, before.clusterId);
  assert.notEqual(after.nodeId, before.nodeId);
  assert.ok(after.hostname === 'manager-02' || after.hostname === 'manager-03');

  const observedCluster = await guarded.inspectCluster();
  assert.equal(observedCluster.cluster.id, registration.swarmClusterId);
  assert.equal(observedCluster.nodes.length, 3);
  assert.deepEqual(await new ClusterRegistrationRepository(db).find('default'), registration);

  const restarted = registeredAgentClient(
    new HttpAgentClient(registry),
    new ClusterBindingPolicy(new ClusterRegistrationRepository(db), settings),
  );
  const restartedIdentity = await restarted.identity();
  assert.equal(restartedIdentity.clusterId, registration.swarmClusterId);
  assert.notEqual(restartedIdentity.nodeId, before.nodeId);
  const [auditsAfter] = await db.query(
    "SELECT COUNT(*) AS count FROM audit_events WHERE operation_id = ? AND action = 'CLUSTER_REGISTERED'",
    [registration.id],
  );
  assert.equal(Number(auditsAfter[0].count), 1);

  writeFileSync(process.env.DOCKLANE_FAILOVER_EVIDENCE, JSON.stringify({
    registeredEnforcement: true,
    registeredClusterId: registration.swarmClusterId,
    registrationId: registration.id,
    initialRejection: 'CLUSTER_REGISTRATION_REQUIRED',
    driftRejection: 'CLUSTER_REGISTRATION_MISMATCH',
    auditCount: 1,
    before,
    after,
    restarted: { nodeId: restartedIdentity.nodeId, clusterId: restartedIdentity.clusterId },
  }, null, 2) + '\n');
} finally {
  await db.onModuleDestroy();
}
