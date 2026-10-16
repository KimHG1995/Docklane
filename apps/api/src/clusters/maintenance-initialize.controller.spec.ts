import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceInitializeController } from './maintenance-initialize.controller.js';

const request = (role: string, clusters: string[]) => ({
  principal: { actorId: '관리자', role, clusters },
});
function fixture(actualCluster='swarm-A') {
  const calls: string[] = [];
  return {
    calls,
    controller: new MaintenanceInitializeController(
      { clusterId:'default',
        settings:{mode:'enforce',expectedSwarmClusterId:'swarm-A'},
        assertRegistered:async()=>{calls.push('registration');} } as never,
      { initializeOpen:async()=>{calls.push('initialize');return {
        clusterId:'default',state:'OPEN',generation:1n,
      };} } as never,
      { identity:async()=>{calls.push('identity');return {
        manager:true,nodeId:'manager-a',clusterId:actualCluster,
      };} } as never,
    ),
  };
}
test('explicit initialization verifies live manager before database writes',async()=>{
  const {controller,calls}=fixture();
  const result=await controller.initialize('default',request('ADMIN',['default']) as never,{reason:'bootstrap'});
  assert.equal(result.generation,'1');
  assert.deepEqual(calls,['registration','identity','initialize']);
});
test('restored or rejoined foreign Swarm must never initialize OPEN',async()=>{
  const {controller,calls}=fixture('swarm-B');
  await assert.rejects(()=>controller.initialize('default',request('ADMIN',['default']) as never,
    {reason:'bootstrap'}),/Current Docker Swarm differs/);
  assert.deepEqual(calls,['registration','identity']);
});
test('wrong role refuses initializer before identity or database read',async()=>{
  const {controller,calls}=fixture();
  await assert.rejects(()=>controller.initialize('default',request('VIEWER',['default']) as never,
    {reason:'bootstrap'}),/scoped ADMIN/);
  assert.equal(calls.length,0);
});
