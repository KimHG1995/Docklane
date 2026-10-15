import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceManagerBarrier } from './maintenance-manager-barrier.js';

function fixture(failId: string | null = null) {
  const calls: string[] = [];
  const targets = [{agentId:'manager-0',nodeId:'node-0'},{agentId:'manager-1',nodeId:'node-1'}];
  const agent = {
    inspectConfiguredManagers: async () => targets,
    blockConfiguredManager: async (id: string) => {
      calls.push(id);
      if (id === failId) throw new Error('Agent unavailable');
    },
  };
  const db = { query: async (sql:string) => {
    if (sql.includes('SELECT agent_id')) return [[
      {agent_id:'manager-0',generation:'2',state:'ACKNOWLEDGED'},
      {agent_id:'manager-1',generation:'2',state:'ACKNOWLEDGED'},
    ]];
    return [{affectedRows:1}];
  }};
  const maintenance = { requireRecord: async () => ({state:'CLOSING',generation:2n}) };
  return {
    barrier: new MaintenanceManagerBarrier(agent as never,maintenance as never,db as never,
      { expectedClusterId:'swarm-a', agents:[{id:'manager-0'},{id:'manager-1'}] } as never),
    calls,
  };
}
test('all managers required at exact generation', async () => {
  const {barrier,calls}=fixture();
  const result=await barrier.blockAll('default','swarm-a',2n);
  assert.deepEqual(result.blockedManagerIds,['manager-0','manager-1']);
  assert.deepEqual(calls,['manager-0','manager-1']);
});
test('unreachable manager fails closed without all-manager success', async () => {
  const {barrier,calls}=fixture('manager-1');
  await assert.rejects(()=>barrier.blockAll('default','swarm-a',2n),/Agent unavailable/);
  assert.deepEqual(calls,['manager-0','manager-1']);
});
test('stale generation refuses barrier requests before mutation', async () => {
  const {barrier,calls}=fixture();
  await assert.rejects(()=>barrier.blockAll('default','swarm-a',1n),/generation/);
  assert.equal(calls.length,0);
});
