import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredAgentClient } from './registered-agent-client.js';
import { isDeterministicAgentRejection, MaintenancePreDispatchRejection, AgentRequestError } from '../agent/agent-client.js';

test('maintenance final dispatch denies closed and missing row, preserving reads', async () => {
  const previous = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    let dispatched = 0;
    const raw = {
      inspectService: async () => ({ ok: true }),
      restartService: async () => { dispatched += 1; return { ok: true }; },
    };
    let state: unknown[] = [{ state: 'CLOSING', generation: '3' }];
    const db = { query: async () => [state] };
    const policy = {
      clusterId: 'default',
      assertRegistered: async () => {},
      activeLockConnection: () => null,
    };
    const agent = registeredAgentClient(raw as never, policy as never, db as never);
    await agent.inspectService('test');
    await assert.rejects(() => agent.restartService('test', {} as never), (error: unknown) => error instanceof MaintenancePreDispatchRejection && isDeterministicAgentRejection(error));
    assert.equal(dispatched, 0);
    state = [];
    await assert.rejects(() => agent.restartService('test', {} as never), /Maintenance prevents/);
    state = [{ state: 'OPEN', generation: '3' }];
    await agent.restartService('test', {} as never);
    assert.equal(dispatched, 1);
  } finally {
    if (previous === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = previous;
  }
});

test('maintenance final dispatch uses active lock connection rather than checking out pool', async () => {
  const previous = process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE = '1';
  try {
    let poolChecks = 0;
    let lockedChecks = 0;
    const raw = { drainNode: async () => ({ ok: true }) };
    const db = { query: async () => { poolChecks += 1; throw new Error('unexpected pool query'); } };
    const policy = {
      clusterId: 'default',
      assertRegistered: async () => {},
      activeLockConnection: () => ({
        query: async () => { lockedChecks += 1; return [[{ state: 'OPEN', generation: '1' }]]; },
      }),
    };
    const agent = registeredAgentClient(raw as never, policy as never, db as never);
    await agent.drainNode('node', {} as never);
    assert.equal(lockedChecks, 1);
    assert.equal(poolChecks, 0);
  } finally {
    if (previous === undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE = previous;
  }
});

test('only pre-dispatch maintenance rejection is deterministic, not generic 503', () => {
  assert.equal(isDeterministicAgentRejection(new MaintenancePreDispatchRejection('MAINTENANCE_CLOSED')), true);
  assert.equal(isDeterministicAgentRejection(new MaintenancePreDispatchRejection('MAINTENANCE_UNAVAILABLE')), true);
  assert.equal(isDeterministicAgentRejection(new AgentRequestError(503, '{"code":"MAINTENANCE_UNAVAILABLE"}')), false);
});
