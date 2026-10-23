import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceManagerBarrier } from './maintenance-manager-barrier.js';

function fixture(failId: string | null = null) {
  const calls: string[] = [];
  const readbacks: unknown[][] = [];
  const targets = [{agentId:'manager-0',nodeId:'node-0'},{agentId:'manager-1',nodeId:'node-1'}];
  const agent = {
    inspectConfiguredManagers: async () => targets,
    inspectManagerBarrier: async (...args: unknown[]) => { readbacks.push(args); },
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
    calls, readbacks, agent,
  };
}
test('all managers required at exact generation', async () => {
  const {barrier,calls,readbacks}=fixture();
  const result=await barrier.blockAll('default','swarm-a',2n);
  assert.deepEqual(result.blockedManagerIds,['manager-0','manager-1']);
  assert.deepEqual(calls,['manager-0','manager-1']);
  assert.deepEqual(readbacks,[
    ['manager-0','node-0','swarm-a',2n,'BLOCKED'],
    ['manager-1','node-1','swarm-a',2n,'BLOCKED'],
  ]);
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


test('manager reopening is verified only after committed OPEN generation', async () => {
  const calls: string[] = [];
  const agent = {
    inspectConfiguredManagers: async () => [
      {agentId:'manager-0',nodeId:'node-0'},
      {agentId:'manager-1',nodeId:'node-1'},
    ],
    openConfiguredManager: async (id:string) => { calls.push('open-'+id); },
    inspectManagerBarrier: async (id:string) => { calls.push('inspect-'+id); },
  };
  const maintenance = {requireRecord: async () => ({state:'OPEN',generation:11n})};
  const barrier = new MaintenanceManagerBarrier(agent as never,maintenance as never,{} as never,
    {expectedClusterId:'swarm-a',agents:[{id:'manager-0'},{id:'manager-1'}]} as never);
  const result=await barrier.openAll('default','swarm-a',11n);
  assert.deepEqual(result.openManagerIds,['manager-0','manager-1']);
  assert.deepEqual(calls,['open-manager-0','open-manager-1','inspect-manager-0','inspect-manager-1']);
});

test('reopening must reject stale generation before contacting Agent', async () => {
  let called=false;
  const agent = {inspectConfiguredManagers:async()=>{called=true;return []}};
  const barrier = new MaintenanceManagerBarrier(agent as never,
    {requireRecord:async()=>({state:'RECONCILING',generation:10n})} as never,
    {} as never,{expectedClusterId:'swarm-a',agents:[{id:'manager-0'}]} as never);
  await assert.rejects(()=>barrier.openAll('default','swarm-a',11n),/committed OPEN/);
  assert.equal(called,false);
});


test('persisted ACKs cannot hide a failed fresh BLOCKED readback', async () => {
  const {barrier,agent}=fixture();
  agent.inspectManagerBarrier=async () => { throw new Error('Barrier no longer BLOCKED'); };
  await assert.rejects(()=>barrier.blockAll('default','swarm-a',2n),/Barrier no longer BLOCKED/);
});

test('manager replacement during readbacks invalidates prior BLOCKED ACKs', async () => {
  const {barrier,agent}=fixture();
  let rosterReads=0;
  agent.inspectConfiguredManagers=async () => {
    rosterReads++;
    return [
      {agentId:'manager-0',nodeId:'node-0'},
      {agentId:'manager-1',nodeId:rosterReads===3?'replacement-node':'node-1'},
    ];
  };
  await assert.rejects(()=>barrier.blockAll('default','swarm-a',2n),/final block verification/);
  assert.equal(rosterReads,3);
});
