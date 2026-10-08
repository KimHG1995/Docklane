import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import type { AgentClient } from '../agent/agent-client.js';
import type { ManagerAgentConfig } from '../agent/agent-config.js';
import type { Principal } from '../auth/auth.types.js';
import { ClusterRegistrationService } from './cluster-registration.service.js';
import type { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import type { ClusterRegistrationRecord } from './cluster-registration.types.js';

const originalCluster = process.env.DOCKLANE_CLUSTER_ID;
beforeEach(() => { process.env.DOCKLANE_CLUSTER_ID = 'default'; });
afterEach(() => {
  if (originalCluster === undefined) delete process.env.DOCKLANE_CLUSTER_ID;
  else process.env.DOCKLANE_CLUSTER_ID = originalCluster;
});

const admin: Principal = { actorId: 'admin-a', role: 'ADMIN', clusters: ['default'] };
const input = { swarmClusterId: 'swarm-a', displayName: '공공 운영' };
const record: ClusterRegistrationRecord = {
  id: 'registration-1', clusterId: 'default', ...input,
  registeredBy: 'admin-a', verifiedNodeId: 'node-a', createdAt: '2026-10-08T00:00:00.000Z',
};

function fixture(existing: ClusterRegistrationRecord | null = null) {
  const state = { row: existing, identities: 0, reads: 0, writes: 0, error: null as Error | null,
    identity: { component: 'docklane-agent', manager: true, leader: true, hostname: 'host-a',
      nodeId: 'node-a', clusterId: 'swarm-a' } };
  const registry: ManagerAgentConfig = {
    primaryId: 'agent-a', expectedClusterId: 'swarm-a',
    agents: [{ id: 'agent-a', baseUrl: 'https://agent.invalid', insecureDev: false }],
  };
  const agent = {
    async identity() { state.identities++; if (state.error) throw state.error; return state.identity; },
  } as unknown as AgentClient;
  const repository = {
    async find() { state.reads++; return state.row; },
    async register(value: Omit<ClusterRegistrationRecord, 'id' | 'createdAt'>) {
      state.writes++; state.row = { id: 'registration-1', createdAt: record.createdAt, ...value };
      return state.row;
    },
  } as unknown as ClusterRegistrationRepository;
  const create = () => new ClusterRegistrationService(agent, repository, registry);
  return { state, registry, create };
}

const status = (code: number) => (error: unknown) =>
  error !== null && typeof error === 'object' && 'getStatus' in error &&
  typeof error.getStatus === 'function' && error.getStatus() === code;

test('register binds configured logical and actual identities without sending a Docker mutation', async () => {
  const f = fixture();
  const result = await f.create().register('default', input, admin);
  assert.deepEqual(result, record);
  assert.equal(f.state.identities, 1);
  assert.equal(f.state.writes, 1);
});

test('registration requires ADMIN and the same cluster scope before any I/O', async () => {
  for (const principal of [
    { ...admin, role: 'VIEWER' as const }, { ...admin, role: 'OPERATOR' as const },
    { ...admin, clusters: ['other'] },
  ]) {
    const f = fixture();
    await assert.rejects(f.create().register('default', input, principal), status(403));
    await assert.rejects(f.create().get('default', principal), status(403));
    assert.equal(f.state.reads + f.state.writes + f.state.identities, 0);
  }
});

test('wildcard-scoped ADMIN can register only the configured logical cluster', async () => {
  const f = fixture();
  const service = f.create();
  await assert.rejects(service.register('other', input, { ...admin, clusters: ['*'] }), status(404));
  assert.equal(f.state.identities + f.state.reads, 0);
  assert.equal((await service.register('default', input, { ...admin, clusters: ['*'] })).clusterId, 'default');
});

test('request cannot replace the configured actual Swarm binding', async () => {
  const f = fixture();
  await assert.rejects(f.create().register('default', { ...input, swarmClusterId: 'swarm-b' }, admin), status(409));
  assert.equal(f.state.reads + f.state.writes + f.state.identities, 0);
});

test('insecure discovery alone is insufficient for durable registration', async () => {
  const f = fixture();
  delete f.registry.expectedClusterId;
  f.registry.agents[0]!.insecureDev = true;
  await assert.rejects(f.create().register('default', input, admin), status(409));
  assert.equal(f.state.reads + f.state.writes + f.state.identities, 0);
});

test('configured binding is snapshotted, not changed by registry object mutation', async () => {
  const f = fixture();
  const service = f.create();
  f.registry.expectedClusterId = 'swarm-b';
  await service.register('default', input, admin);
  assert.equal(f.state.row?.swarmClusterId, 'swarm-a');
});

test('foreign, nonmanager or malformed live identity cannot be registered', async () => {
  for (const change of [
    { clusterId: 'swarm-b' }, { manager: false }, { nodeId: '' },
    { nodeId: 'node\ninvalid' }, { component: 'not-docklane-agent' },
  ]) {
    const f = fixture();
    Object.assign(f.state.identity, change);
    await assert.rejects(f.create().register('default', input, admin));
    assert.equal(f.state.writes, 0);
  }
});

test('Agent lookup failure is not persisted and private errors are not returned', async () => {
  const f = fixture();
  f.state.error = new Error('private TLS path and credentials');
  await assert.rejects(f.create().register('default', input, admin), (error: unknown) => {
    assert.equal(status(502)(error), true);
    assert.doesNotMatch(String(error), /private TLS/);
    return true;
  });
  assert.equal(f.state.writes, 0);
});

test('same registration replay returns persisted result during an Agent outage without reauditing', async () => {
  const f = fixture({ ...record });
  f.state.error = new Error('Agent offline');
  const result = await f.create().register('default', input, { ...admin, actorId: 'admin-b' });
  assert.deepEqual(result, record);
  assert.equal(f.state.identities + f.state.writes, 0);
});

test('registration cannot overwrite existing identity or display metadata', async () => {
  for (const change of [{ swarmClusterId: 'swarm-b' }, { displayName: 'different name' }]) {
    const f = fixture({ ...record, ...change });
    await assert.rejects(f.create().register('default', input, admin), status(409));
    assert.equal(f.state.identities + f.state.writes, 0);
  }
});

test('registration GET reports stored metadata and config drift, not live health', async () => {
  const f = fixture({ ...record });
  f.registry.expectedClusterId = 'swarm-b';
  f.state.error = new Error('Agent offline');
  const value = await f.create().get('default', admin);
  assert.deepEqual(value.registration, record);
  assert.equal(value.configuredSwarmClusterId, 'swarm-b');
  assert.equal(value.matchesConfiguration, false);
  assert.equal(f.state.identities + f.state.writes, 0);
});

test('registration GET does not invent an unregistered cluster', async () => {
  const f = fixture();
  await assert.rejects(f.create().get('default', admin), status(404));
  assert.equal(f.state.identities + f.state.writes, 0);
});

test('existing registration does not authorize repinning after a service restart', async () => {
  const f = fixture({ ...record });
  f.registry.expectedClusterId = 'swarm-b';
  await assert.rejects(f.create().register('default', { ...input, swarmClusterId: 'swarm-b' }, admin), status(409));
  assert.equal(f.state.identities + f.state.writes, 0);
  assert.equal(f.state.row?.swarmClusterId, 'swarm-a');
});
