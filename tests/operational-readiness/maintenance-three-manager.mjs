import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { Database } from '../../apps/api/dist/db/database.js';
import { ClusterRegistrationRepository } from '../../apps/api/dist/clusters/cluster-registration.repository.js';
import { ClusterBindingPolicy } from '../../apps/api/dist/clusters/cluster-binding.policy.js';
import { ClusterMaintenanceRepository } from '../../apps/api/dist/clusters/cluster-maintenance.repository.js';
import { MaintenanceControlLease } from '../../apps/api/dist/clusters/maintenance-control-lease.js';
import { MaintenanceManagerBarrier } from '../../apps/api/dist/clusters/maintenance-manager-barrier.js';
import { MaintenanceDispatchJournal } from '../../apps/api/dist/clusters/maintenance-dispatch-journal.js';
import { HttpAgentClient } from '../../apps/api/dist/agent/http-agent.client.js';
import { registeredAgentClient } from '../../apps/api/dist/clusters/registered-agent-client.js';
import { RegisteredOperationLock } from '../../apps/api/dist/clusters/registered-operation-lock.js';
import { withMutationOperation } from '../../apps/api/dist/agent/mutation-dispatch-context.js';

// Executes only inside the owned disposable three-manager DinD harness.
// No Docker CLI commands are sent to the host swarm. The independent lease
// competitor is another OS process with a separate MySQL pool, not a mock.
const expected = process.env.DOCKLANE_EXPECTED_CLUSTER_ID;
const definitions = JSON.parse(process.env.DOCKLANE_MANAGER_AGENT_URLS);
const cert = readFileSync(process.env.DOCKLANE_AGENT_CERT_FILE);
const key = readFileSync(process.env.DOCKLANE_AGENT_KEY_FILE);
const ca = readFileSync(process.env.DOCKLANE_AGENT_CA_FILE);
const registry = {
  primaryId: 'manager-01', expectedClusterId: expected,
  agents: definitions.map(d => ({...d, insecureDev:false,cert,key,ca})),
};
const containers = {
  'manager-01':process.env.DOCKLANE_MANAGER_01_CONTAINER,
  'manager-02':process.env.DOCKLANE_MANAGER_02_CONTAINER,
  'manager-03':process.env.DOCKLANE_MANAGER_03_CONTAINER,
};
const evidence = {
  topology: 'not-run', lease: 'not-run',
  serviceUpdate: 'not-run', nodeUpdate:'not-run',
  blockAll:'not-run', blockedRoutes:'not-run', staleRoutes:'not-run',
  close:'not-run', recovery:'not-run',
  partialReopen:'not-run', rejoin:'not-run',
};
const db = new Database();
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8',timeout:120000}).trim();
function runCpWorker() {
  return spawnSync(process.execPath,
    ['tests/operational-readiness/maintenance-cp-worker.mjs'],{
      cwd:process.cwd(),encoding:'utf8',timeout:30000,
      env:{...process.env,DOCKLANE_DATABASE_URL:process.env.DOCKLANE_DATABASE_URL},
    });
}
async function postMutationTo(manager, path, clusterId, generation) {
  const target=registry.agents.find(a=>a.id===manager);
  assert.ok(target);
  const url=new URL(path,target.baseUrl);
  return new Promise((resolve,reject) => {
    const req=httpsRequest(url,{
      method:'POST',ca,cert,key,timeout:5000,
      headers:{
        'content-type':'application/json',
        'X-Docklane-Expected-Cluster-ID':clusterId,
        'X-Docklane-Maintenance-Generation':String(generation),
      },
    },res=>{
      let body='';
      res.on('data',x=>{body+=x;});
      res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(new Error('Agent timed out')));
    req.end('{}');
  });
}
function restartOwnedAgent(manager) {
  const container=containers[manager];
  assert.ok(container);
  const command=[
    'DOCKER_HOST=unix:///var/run/docker.sock',
    'DOCKLANE_AGENT_ADDR=0.0.0.0:9443',
    'DOCKLANE_AGENT_MAINTENANCE_STATE_FILE=/etc/docklane/maintenance-state.json',
    'DOCKLANE_AGENT_TLS_CERT_FILE=/etc/docklane/agent.crt',
    'DOCKLANE_AGENT_TLS_KEY_FILE=/etc/docklane/agent.key',
    'DOCKLANE_AGENT_TLS_CA_FILE=/etc/docklane/agent-ca.crt',
    '/usr/local/bin/docklane-agent >/var/log/docklane-agent.log 2>&1 &',
  ].join(' ');
  docker('exec',container,'sh','-c',command);
}
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
async function waitAgentBarrier(raw, agentId, nodeId, clusterId, generation,state) {
  let last;
  for(let attempt=0;attempt<35;attempt++){
    try {
      await raw.inspectManagerBarrier(agentId,nodeId,clusterId,generation,state);
      return;
    } catch(error) {last=error;await sleep(300);}
  }
  throw last;
}
let serviceId='';
try {
  await db.onModuleInit();
  process.env.DOCKLANE_MAINTENANCE_ENFORCE='1';
  const reg=new ClusterRegistrationRepository(db);
  const initialManager = new HttpAgentClient(registry);
  const liveIdentity = await initialManager.identity();
  assert.equal(liveIdentity.clusterId,expected);
  const record=await reg.register({
    clusterId:'default',swarmClusterId:expected,
    displayName:'disposable-maintenance-acceptance',
    registeredBy:'acceptance-admin',verifiedNodeId:liveIdentity.nodeId,
  });
  assert.equal(record.swarmClusterId,expected);
  const policy=new ClusterBindingPolicy(reg,{
    mode:'enforce',logicalClusterId:'default',expectedSwarmClusterId:expected,
  });
  const leases=new MaintenanceControlLease(db);
  const maintenance=new ClusterMaintenanceRepository(db,leases);
  const journal=new MaintenanceDispatchJournal(db);
  const raw=new HttpAgentClient(registry,journal);
  const selected=await raw.inspectConfiguredManagers(expected);
  assert.equal(selected.length,3);
  evidence.topology={swarmId:expected,managerIds:selected.map(t=>t.nodeId)};
  const initial=await maintenance.initializeOpen('default','acceptance-admin','three-manager acceptance');
  assert.equal(initial.state,'OPEN');
  assert.equal(initial.generation,1n);
  for(const manager of selected) {
    await raw.openConfiguredManager(manager.agentId,manager.nodeId,expected,1n);
    await raw.inspectManagerBarrier(manager.agentId,manager.nodeId,expected,1n,'OPEN');
  }
  // Two independent CP processes compete on exactly the same persisted lease.
  const own=await leases.acquire('default',30);
  const rival=runCpWorker();
  assert.equal(rival.status,2,'second CP must be denied while lease is owned');
  await leases.release(own);
  const replacement=runCpWorker();
  assert.equal(replacement.status,0, replacement.stderr);
  const adopted=JSON.parse(replacement.stdout);
  assert.ok(BigInt(adopted.token)>own.token);
  const staleConnection=await db.getConnection();
  try {
    await assert.rejects(()=>leases.assertOwner(staleConnection,own),/fenced/);
  } finally {staleConnection.release();}
  evidence.lease={original:own.token.toString(),replacement:adopted.token,staleRefused:true};

  // Real ServiceUpdate through the journalled CP -> mTLS Agent -> Docker path.
  serviceId=docker('exec',containers['manager-01'],'docker','service','create',
    '--detach=true','--replicas','0','--no-resolve-image','--name','docklane-maint-accept',
    'alpine:3.20','sleep','3600').split('\n').at(-1);
  assert.match(serviceId,/^[0-9a-z]{12,}$/);
  const oldVersion=Number(docker('exec',containers['manager-01'],'docker',
    'service','inspect',serviceId,'--format','{{.Version.Index}}'));
  const operationLock=new RegisteredOperationLock(db,policy);
  const guarded=registeredAgentClient(raw,policy,db);
  const before=await raw.inspectService(serviceId);
  const restartPlan=await raw.planRestartService(serviceId,before.service.version);
  const restartResult=await operationLock.withServiceLock('default',serviceId,
    ()=>withMutationOperation('maint-real-service-restart-'+randomUUID(),
      ()=>guarded.restartService(serviceId,{
        expectedVersion:restartPlan.version,
        expectedSpecHash:restartPlan.beforeSpecHash,
        targetSpecHash:restartPlan.targetSpecHash,
      })));
  assert.equal(restartResult.serviceId,serviceId);
  const newVersion=Number(docker('exec',containers['manager-01'],'docker',
    'service','inspect',serviceId,'--format','{{.Version.Index}}'));
  assert.ok(newVersion>oldVersion,'real ServiceUpdate must reach Docker');
  const blockedServiceFingerprint=(await raw.inspectService(serviceId)).service.specHash;
  evidence.serviceUpdate={serviceId,oldVersion,newVersion};

  // Real NodeUpdate on an owned disposable manager, with replicas=0 service.
  const targetNode=selected[2];
  const beforeNode=await raw.inspectNode(targetNode.nodeId);
  const labelPlan=await raw.planNodeLabels(targetNode.nodeId,{
    expectedVersion:beforeNode.node.version,
    set:{docklane_maintenance_acceptance:'verified'},remove:[],
  });
  const nodeResult=await operationLock.withNodeAndServiceLocks('default',
    targetNode.nodeId,labelPlan.affectedServiceIds,
    ()=>withMutationOperation('maint-real-node-label-'+randomUUID(),
      ()=>guarded.updateNodeLabels(targetNode.nodeId,{
        expectedVersion:labelPlan.version,
        expectedSpecHash:labelPlan.beforeSpecHash,
        targetSpecHash:labelPlan.targetSpecHash,
        expectedServiceIds:labelPlan.affectedServiceIds,
        targetLabels:labelPlan.targetLabels,
      })));
  assert.equal(nodeResult.nodeId,targetNode.nodeId);
  const afterNode=await raw.inspectNode(targetNode.nodeId);
  assert.ok(afterNode.node.version>beforeNode.node.version);
  evidence.nodeUpdate={nodeId:targetNode.nodeId,
    beforeVersion:beforeNode.node.version,afterVersion:afterNode.node.version};

  assert.equal(await maintenance.requestClosing('default',1n,'acceptance-admin','drain all managers'),true);
  const closedLease=await leases.acquire('default',30);
  try {
    const barrier=new MaintenanceManagerBarrier(raw,maintenance,db,registry);
    const blocked=await barrier.blockAll('default',expected,2n);
    assert.deepEqual(blocked.blockedManagerIds,registry.agents.map(a=>a.id).sort());
    evidence.blockAll=blocked;

    // All seven actual mutation HTTP routes must reject before Docker dispatch.
    const paths=[
      '/v2/services/'+serviceId+'/scale',
      '/v2/services/'+serviceId+'/restart',
      '/v2/services/'+serviceId+'/image',
      '/v2/services/'+serviceId+'/rollback',
      '/v2/nodes/'+targetNode.nodeId+'/drain',
      '/v2/nodes/'+targetNode.nodeId+'/activate',
      '/v2/nodes/'+targetNode.nodeId+'/labels',
    ];
    const results=[];
    for(const manager of selected)for(const path of paths){
      // P2 regression: use the CURRENT (BLOCKED) generation, not a stale one.
      // A stale-generation-only guard returning 409 must NOT pass this test.
      const result=await postMutationTo(manager.agentId,path,expected,2n);
      assert.equal(result.status,409,`${manager.agentId} ${path}: ${result.body}`);
      const response=JSON.parse(result.body);
      assert.equal(response.code,'MAINTENANCE_AGENT_BLOCKED',
        `expected BLOCKED rejection at current generation: ${manager.agentId} ${path}`);
      results.push({manager:manager.agentId,path,status:result.status,
        requestGeneration:'2',code:response.code});
    }
    assert.equal(results.length,21);
    const blockedService=await raw.inspectService(serviceId);
    const blockedNode=await raw.inspectNode(targetNode.nodeId);
    assert.equal(blockedService.service.version,newVersion,
      'BLOCKED must not invoke Docker ServiceUpdate');
    assert.equal(blockedService.service.specHash,blockedServiceFingerprint,
      'BLOCKED must preserve service spec fingerprint');
    assert.equal(blockedNode.node.version,afterNode.node.version,
      'BLOCKED must not invoke Docker NodeUpdate');
    assert.equal(blockedNode.node.specHash,afterNode.node.specHash,
      'BLOCKED must preserve node spec fingerprint');
    evidence.blockedRoutes={cases:results,
      unchangedService:{version:blockedService.service.version,specHash:blockedService.service.specHash},
      unchangedNode:{version:blockedNode.node.version,specHash:blockedNode.node.specHash}};
    assert.equal(await maintenance.commitClosed('default',2n,'acceptance-admin',
      'all handlers drained and evidence reconciled',blocked.blockedManagerIds,closedLease),true);
    assert.equal((await maintenance.requireRecord('default')).state,'CLOSED');
  } finally {await leases.release(closedLease);}
  evidence.close='CLOSED generation 3';

  const recoverLease=await leases.acquire('default',30);
  const barrier=new MaintenanceManagerBarrier(raw,maintenance,db,registry);
  try {
    assert.equal(await maintenance.commitRecoveryTransition('default',3n,
      'acceptance-admin','begin recovery','CLOSED',recoverLease),true);
    const blocked=await barrier.blockAll('default',expected,4n);
    assert.equal(await maintenance.commitRecoveryTransition('default',4n,
      'acceptance-admin','fully reconciled','RECONCILING',
      recoverLease,blocked.blockedManagerIds),true);
    evidence.recovery='OPEN database committed at generation 5';
  } finally {await leases.release(recoverLease);}

  // Lose one manager Agent OPEN acknowledgement, then restart it from the
  // owned DinD image with its durable BLOCKED state file still present.
  docker('exec',containers['manager-03'],'sh','-c',
    'pid="$(pidof docklane-agent)" && test -n "$pid" && kill "$pid"');
  await assert.rejects(()=>barrier.openAll('default',expected,5n));
  evidence.partialReopen='manager-03 acknowledgement loss rejected';
  restartOwnedAgent('manager-03');
  await waitAgentBarrier(raw,'manager-03',targetNode.nodeId,expected,4n,'BLOCKED');
  const resumed=await barrier.openAll('default',expected,5n);
  assert.equal(resumed.openManagerIds.length,3);
  evidence.partialReopen=resumed;

  // Independent stale-generation assertion while every manager is OPEN.
  // It must be MAINTENANCE_GENERATION_STALE rather than AGENT_BLOCKED.
  const stalePaths=[
    '/v2/services/'+serviceId+'/scale',
    '/v2/services/'+serviceId+'/restart',
    '/v2/services/'+serviceId+'/image',
    '/v2/services/'+serviceId+'/rollback',
    '/v2/nodes/'+targetNode.nodeId+'/drain',
    '/v2/nodes/'+targetNode.nodeId+'/activate',
    '/v2/nodes/'+targetNode.nodeId+'/labels',
  ];
  const staleResults=[];
  for(const manager of selected)for(const path of stalePaths){
    const result=await postMutationTo(manager.agentId,path,expected,4n);
    assert.equal(result.status,409,`expected stale generation rejection: ${manager.agentId} ${path}`);
    const response=JSON.parse(result.body);
    assert.equal(response.code,'MAINTENANCE_GENERATION_STALE',
      `wrong 409 rejection reason: ${manager.agentId} ${path}`);
    staleResults.push({manager:manager.agentId,path,status:result.status,
      requestGeneration:'4',currentGeneration:'5',code:response.code});
  }
  assert.equal(staleResults.length,21);
  const staleService=await raw.inspectService(serviceId);
  const staleNode=await raw.inspectNode(targetNode.nodeId);
  assert.equal(staleService.service.version,newVersion);
  assert.equal(staleService.service.specHash,blockedServiceFingerprint);
  assert.equal(staleNode.node.version,afterNode.node.version);
  assert.equal(staleNode.node.specHash,afterNode.node.specHash);
  evidence.staleRoutes=staleResults;

  // Rejoin is tested LAST: it deliberately changes one owned manager's
  // cluster ID and must not be mistaken for a successful barrier read.
  const manager03Ip=docker('inspect','--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',containers['manager-03']);
  docker('exec',containers['manager-03'],'docker','swarm','leave','--force');
  docker('exec',containers['manager-03'],'docker','swarm','init','--advertise-addr',manager03Ip);
  const foreign=docker('exec',containers['manager-03'],'docker','info',
    '--format','{{.Swarm.Cluster.ID}}');
  assert.notEqual(foreign,expected);
  await assert.rejects(()=>raw.inspectManagerBarrier('manager-03',
    targetNode.nodeId,expected,5n,'OPEN'));
  const blockedRejoin=await postMutationTo('manager-03',
    '/v2/services/'+serviceId+'/restart',foreign,5n);
  assert.equal(blockedRejoin.status,412);
  evidence.rejoin={oldSwarmId:expected,newSwarmId:foreign,
    mutationRejected:blockedRejoin.status};
} finally {
  if(serviceId)try {
    docker('exec',containers['manager-01'],'docker','service','rm',serviceId);
  } catch {/* Container-scoped teardown also removes the owned service. */}
  writeFileSync(process.env.DOCKLANE_MAINTENANCE_ACCEPT_EVIDENCE,
    JSON.stringify(evidence,null,2)+'\n');
  await db.onModuleDestroy();
}
assert.ok(Object.values(evidence).every(x=>x!=='not-run'),
  'Maintenance acceptance is incomplete');
console.log('maintenance actual three-manager two-process CP acceptance: PASS');
