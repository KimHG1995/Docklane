import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { AgentClient } from '../agent/agent-client.js';
import type { Database } from '../db/database.js';
import { ClusterBindingGuard, RequireClusterBinding, SkipClusterBinding } from './cluster-binding.guard.js';
import { ClusterBindingPolicy, ClusterBindingUnavailable, loadClusterBindingSettings } from './cluster-binding.policy.js';
import { registeredAgentClient } from './registered-agent-client.js';
import { RegisteredOperationLock } from './registered-operation-lock.js';
import type { ClusterRegistrationRepository } from './cluster-registration.repository.js';

const settings = { mode: 'enforce' as const, logicalClusterId: 'default', expectedSwarmClusterId: 'swarm-a' };
const record = { id: 'reg', clusterId: 'default', swarmClusterId: 'swarm-a', displayName: 'prod', registeredBy: 'admin', verifiedNodeId: 'manager', createdAt: '2026-10-08T00:00:00.000Z' };
function fixture(initial: typeof record | null = record) {
  const state = { record: initial, reads: 0, fail: false };
  const repository = { find: async () => { state.reads++; if (state.fail) throw new Error('private database details'); return state.record; } } as unknown as ClusterRegistrationRepository;
  return { state, policy: new ClusterBindingPolicy(repository, settings) };
}
const status = (code: number) => (error: unknown) => error !== null && typeof error === 'object' && 'getStatus' in error &&
  typeof error.getStatus === 'function' && error.getStatus() === code;

test('strict mode requires a fixed cluster, invalid modes never silently fall back', () => {
  assert.equal(loadClusterBindingSettings({}).mode, 'compat');
  assert.throws(() => loadClusterBindingSettings({ DOCKLANE_CLUSTER_REGISTRATION_MODE: 'enabled' }), /compat or enforce/);
  assert.throws(() => loadClusterBindingSettings({ DOCKLANE_CLUSTER_REGISTRATION_MODE: 'enforce' }), /fixed Swarm/);
  assert.deepEqual(loadClusterBindingSettings({ DOCKLANE_CLUSTER_REGISTRATION_MODE: 'enforce', DOCKLANE_EXPECTED_CLUSTER_ID: 'swarm-a' }), settings);
});

test('unregistered, mismatch and database errors fail closed without leaking DB details', async () => {
  const f = fixture(null);
  await assert.rejects(f.policy.assertRegistered(), (e: unknown) => e instanceof ClusterBindingUnavailable && status(503)(e));
  f.state.record = { ...record, swarmClusterId: 'swarm-b' };
  await assert.rejects(f.policy.assertRegistered(), status(503));
  f.state.fail = true;
  await assert.rejects(f.policy.assertRegistered(), (e: unknown) => status(503)(e) && !String(e).includes('private database details'));
  assert.equal(f.state.reads, 3);
});

test('no positive cache: removal and config drift are observed on next call', async () => {
  const f = fixture();
  await f.policy.assertRegistered();
  f.state.record = null;
  await assert.rejects(f.policy.assertRegistered(), status(503));
  assert.equal(f.state.reads, 2);
  await assert.rejects(f.policy.assertRegistered('foreign'), status(404));
  assert.equal(f.state.reads, 2);
});

test('compat mode preserves existing workloads without registration DB reads', async () => {
  const f = fixture(null);
  const policy = new ClusterBindingPolicy({ find: async () => { throw new Error('should not query'); } } as never,
    { ...settings, mode: 'compat' });
  await policy.assertRegistered();
  assert.equal(f.state.reads, 0);
});

test('all Agent methods are gated before network I/O; liveness and raw registration remain independent', async () => {
  const f = fixture(null);
  const calls: string[] = [];
  const raw = { health: async () => { calls.push('health'); return { status: 'ok' }; },
    identity: async () => { calls.push('identity'); return { clusterId: 'swarm-a' }; },
    inspectCluster: async () => { calls.push('inspect'); return {}; },
    scaleService: async () => { calls.push('scale'); return {}; } } as unknown as AgentClient;
  const protectedAgent = registeredAgentClient(raw, f.policy);
  await protectedAgent.health();
  await assert.rejects(protectedAgent.identity(), status(503));
  await assert.rejects(protectedAgent.inspectCluster(), status(503));
  await assert.rejects(protectedAgent.scaleService('svc', {} as never), status(503));
  assert.deepEqual(calls, ['health']);
  f.state.record = record;
  await protectedAgent.identity();
  await protectedAgent.scaleService('svc', {} as never);
  assert.deepEqual(calls, ['health', 'identity', 'scale']);
});

test('operation locks reject unregistered clusters before acquiring a DB connection', async () => {
  const f = fixture(null);
  let databaseCalls = 0;
  const db = { getConnection: async () => { databaseCalls++; throw new Error('must not lock'); } } as unknown as Database;
  const lock = new RegisteredOperationLock(db, f.policy);
  await assert.rejects(lock.withServiceLock('default', 'svc', async () => 1), status(503));
  await assert.rejects(lock.withNodeAndServiceLocks('default', 'node', ['svc'], async () => 1), status(503));
  assert.equal(databaseCalls, 0);
});

class UnregisteredController { @SkipClusterBinding() register() {} }
class WorkerController { @RequireClusterBinding() claim() {} }
class ScopedController { services() {} }
function context(controller: object, method: string, clusterId?: string): ExecutionContext {
  return { getHandler: () => (controller as Record<string, unknown>)[method],
    getClass: () => controller.constructor,
    switchToHttp: () => ({ getRequest: () => ({ params: clusterId === undefined ? {} : { clusterId } }) }),
  } as unknown as ExecutionContext;
}

test('registration remains accessible while other scoped and public bootstrap requests are guarded', async () => {
  const f = fixture(null);
  const guard = new ClusterBindingGuard(new Reflector(), f.policy);
  const reg = new UnregisteredController();
  const worker = new WorkerController();
  const scoped = new ScopedController();
  assert.equal(await guard.canActivate(context(reg, 'register', 'default')), true);
  await assert.rejects(guard.canActivate(context(worker, 'claim')), status(503));
  await assert.rejects(guard.canActivate(context(scoped, 'services', 'default')), status(503));
  assert.equal(await guard.canActivate(context(scoped, 'services')), true);
  f.state.record = record;
  assert.equal(await guard.canActivate(context(worker, 'claim')), true);
  assert.equal(await guard.canActivate(context(scoped, 'services', 'default')), true);
});

test('concurrent locked Agent calls use one pooled connection each, even at pool capacity', async () => {
  const max = 10;
  let active = 0;
  let checkouts = 0;
  let admissionReads = 0;
  let mutations = 0;
  const queue: Array<() => void> = [];
  const dbSource = {
    getConnection: async () => {
      checkouts++;
      if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
      return {
        query: async (sql: string, _params?: unknown[]) => {
          if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }], []];
          if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []];
          if (sql.startsWith('SELECT * FROM cluster_registrations')) {
            admissionReads++;
            return [[{ id: record.id, cluster_id: record.clusterId, swarm_cluster_id: record.swarmClusterId,
              display_name: record.displayName, registered_by: record.registeredBy,
              verified_node_id: record.verifiedNodeId, created_at: new Date(record.createdAt) }], []];
          }
          throw Error('unexpected SQL');
        },
        release: () => { active--; queue.shift()?.(); },
        destroy: () => { active--; queue.shift()?.(); },
      };
    },
  };
  const database = {
    ...dbSource,
    query: async (sql: string, params: unknown[]) => {
      const connection = await dbSource.getConnection();
      try { return await connection.query(sql, params); }
      finally { connection.release(); }
    },
  } as unknown as Database;
  const registrations = new (await import('./cluster-registration.repository.js')).ClusterRegistrationRepository(database);
  const policy = new ClusterBindingPolicy(registrations, settings);
  const locks = new RegisteredOperationLock(database, policy);
  const agent = registeredAgentClient({ inspectService: async () => { mutations++; return {} as never; } } as AgentClient, policy);
  const requests = Array.from({ length: max }, (_, i) => locks.withServiceLock(
    'default', 'service-' + i, async () => { await agent.inspectService('service-' + i); },
  ));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(requests),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('pool exhausted by nested registration reads')), 2000);
      })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert.equal(mutations, max);
  assert.equal(checkouts, 20);
  assert.equal(admissionReads, 20);
  assert.equal(active, 0);
});

test('same lock connection is used for registration and never reused after scope ends', async () => {
  const f = fixture();
  let lockedReads = 0;
  const connection = { query: async () => {
    lockedReads++;
    return [[{ id: record.id, cluster_id: record.clusterId, swarm_cluster_id: record.swarmClusterId,
      display_name: record.displayName, registered_by: record.registeredBy,
      verified_node_id: record.verifiedNodeId, created_at: new Date(record.createdAt) }], []];
  } };
  await f.policy.withLockedConnection(connection as never, async () => {
    await f.policy.assertRegistered();
    assert.equal(f.state.reads, 0);
  });
  await f.policy.assertRegistered();
  assert.equal(lockedReads, 1);
  assert.equal(f.state.reads, 1);
});
