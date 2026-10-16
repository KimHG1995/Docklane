import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceEvidenceController } from './maintenance-evidence.controller.js';

const evidenceId = '88888888-8888-4888-8888-888888888888';
const request = (role: string) => ({ principal: {
  actorId: '관리자', role, clusters: ['default'],
} });
function fixture(failBlock=false) {
  const calls: string[] = [];
  const controller = new MaintenanceEvidenceController(
    {clusterId:'default',settings:{mode:'enforce',expectedSwarmClusterId:'swarm-A'},
      assertRegistered:async()=>{calls.push('registered');}} as never,
    {requireRecord:async()=>({state:'CLOSING',generation:3n})} as never,
    {blockAll:async()=>{calls.push('block');
      if(failBlock) throw new Error('Manager unavailable');
      return {blockedManagerIds:['manager-0']};}} as never,
    {acquire:async()=>{calls.push('lease');return {clusterId:'default',holderId:'owner',token:4n};},
      release:async()=>{calls.push('release');}} as never,
    {resolve:async()=>{calls.push('resolve');},
      list:async()=>({admissions:[],dispatch:[]})} as never,
  );
  return {controller,calls};
}
const payload = {type:'ADMISSION',evidenceId,generation:'3',
  reason:'confirmed CP terminated',
  observation:'all manager barriers blocked; CP process terminated; inspected resource'};
test('recovery requires all managers BLOCKED before audit resolver', async()=>{
  const prev=process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    const {controller,calls}=fixture(true);
    await assert.rejects(()=>controller.resolve('default',request('ADMIN') as never,payload),/Manager unavailable/);
    assert.deepEqual(calls,['registered','lease','block','release']);
  } finally {
    if(prev===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=prev;
  }
});
test('successful manual resolution is scoped and ordered',async()=>{
  const prev=process.env.DOCKLANE_MAINTENANCE_ENFORCE;
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  try {
    const {controller,calls}=fixture();
    await assert.rejects(()=>controller.resolve('default',request('VIEWER') as never,payload),/Scoped ADMIN/);
    assert.equal(calls.length,0);
    const res=await controller.resolve('default',request('ADMIN') as never,payload);
    assert.deepEqual(res,{resolved:true,evidenceId});
    assert.deepEqual(calls,['registered','lease','block','resolve','release']);
  } finally {
    if(prev===undefined) delete process.env.DOCKLANE_MAINTENANCE_ENFORCE;
    else process.env.DOCKLANE_MAINTENANCE_ENFORCE=prev;
  }
});
