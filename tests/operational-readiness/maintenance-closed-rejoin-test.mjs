import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runClosedRejoinAcceptance } from './maintenance-closed-rejoin.mjs';

function fixture({state = 'CLOSED', foreignCode = 'MAINTENANCE_AGENT_BLOCKED'} = {}) {
  const calls = [];
  let restored = false;
  const targetNode = {agentId:'manager-03', nodeId:'old-node'};
  const docker = (...args) => {
    calls.push(args);
    const command = args.join(' ');
    if (command.startsWith('inspect ')) return '172.18.0.3';
    if (command.includes('swarm join --token')) restored = true;
    if (command.includes('join-token')) return 'disposable-fixture-token';
    if (command.includes('Swarm.Cluster.ID')) return 'foreign-swarm';
    if (command.includes('service create')) return 'foreignservice123456';
    if (command.includes('Version.Index')) return '7';
    if (command.includes('Status.State')) return 'down';
    return '';
  };
  return {calls, context:{docker, targetNode,
    containers:{'manager-01':'owned-01','manager-03':'owned-03'}, expected:'original-swarm',
    maintenance:{requireRecord:async () => ({state,generation:3n})},
    raw:{
      inspectManagerBarrier:async (_agent, node) => {if (!restored || node !== 'new-node') throw new Error('foreign identity');},
      inspectConfiguredManagers:async () => {
        if (!restored) throw new Error('foreign roster');
        return [{agentId:'manager-01',nodeId:'one'},{agentId:'manager-02',nodeId:'two'},{agentId:'manager-03',nodeId:'new-node'}];
      },
    },
    postMutationTo:async () => ({status:409,body:JSON.stringify({code:foreignCode})}),
  }};
}

test('CLOSED rejoin preflight refuses OPEN before any Docker change', async () => {
  const {context,calls} = fixture({state:'OPEN'});
  await assert.rejects(() => runClosedRejoinAcceptance(context));
  assert.deepEqual(calls, []);
});

test('CLOSED rejoin requires barrier-specific rejection, not arbitrary 409', async () => {
  const {context} = fixture({foreignCode:'UNRELATED_CONFLICT'});
  await assert.rejects(() => runClosedRejoinAcceptance(context));
});

test('CLOSED rejoin replaces canonical node only after original Swarm BLOCKED readback', async () => {
  const {context,calls} = fixture();
  const result = await runClosedRejoinAcceptance(context);
  assert.equal(result.state, 'CLOSED');
  assert.equal(result.unchangedForeignVersion, '7');
  assert.equal(context.targetNode.nodeId, 'new-node');
  assert.ok(calls.some(args => args.join(' ').includes('node rm old-node')));
  assert.ok(calls.every(args => args[0] === 'inspect' || (args[0] === 'exec' && ['owned-01','owned-03'].includes(args[1]))));
});
