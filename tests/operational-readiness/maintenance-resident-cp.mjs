import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

const MUTATION_PATH = /^\/v2\/(services|nodes)\/[^/]+\/(scale|restart|image|rollback|drain|activate|labels)$/;
const READY_PREFIX = 'DOCKLANE_RESIDENT_CP_READY ';

function bounded(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(message)), ms);}),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Test-only loopback relay. Secure upstream transport remains real mTLS.
 * For one exact mutation, buffer the complete Agent 200, signal application,
 * and withhold completion from the CP until it is killed. Whitespace keeps
 * the production client's inactivity timeout from winning the crash race.
 */
export async function createHeldMutationRelay({targetUrl, cert, key, ca, holdMutationPath = null}) {
  const target = new URL(targetUrl);
  assert.equal(target.protocol, 'https:', 'resident relay requires a real TLS Agent');
  const events = [];
  const upstreamRequests = new Set();
  const holds = new Set();
  let didHold = false;
  let signalApplied;
  const applied = new Promise(resolve => {signalApplied = resolve;});
  const server = createServer((request, response) => {
    const headers = {...request.headers, host:target.host};
    delete headers.connection;
    delete headers['transfer-encoding'];
    const upstream = httpsRequest({
      hostname:target.hostname, port:target.port,
      method:request.method, path:request.url,
      cert, key, ca, rejectUnauthorized:true, headers, timeout:10_000,
    }, received => {
      received.once('error', () => response.destroy());
      const mutation = request.method === 'POST' && MUTATION_PATH.test(request.url ?? '');
      if (!mutation) {
        response.writeHead(received.statusCode ?? 502, received.headers);
        received.pipe(response);
        return;
      }
      const chunks = [];
      let size = 0;
      received.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          received.destroy(new Error('mutation response exceeds acceptance limit'));
          response.destroy();
        } else chunks.push(chunk);
      });
      received.once('end', () => {
        const held = !didHold && request.url === holdMutationPath && received.statusCode === 200;
        const event = {path:request.url, status:received.statusCode, held};
        events.push(event);
        if (held) {
          didHold = true;
          response.writeHead(200, {'content-type':'application/json'});
          response.write(' ');
          const heartbeat = setInterval(() => {if (!response.destroyed) response.write(' ');}, 250);
          const expiry = setTimeout(() => response.destroy(), 45_000);
          const hold = {response, heartbeat, expiry};
          holds.add(hold);
          response.once('close', () => {
            clearInterval(heartbeat);
            clearTimeout(expiry);
            holds.delete(hold);
          });
          signalApplied(event);
          return;
        }
        if (!response.destroyed) {
          response.writeHead(received.statusCode ?? 502, {'content-type':'application/json'});
          response.end(Buffer.concat(chunks));
        }
      });
    });
    upstreamRequests.add(upstream);
    upstream.once('close', () => upstreamRequests.delete(upstream));
    upstream.once('timeout', () => upstream.destroy(new Error('relay upstream timeout')));
    upstream.once('error', () => {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed) {
        response.writeHead(502, {'content-type':'application/json'});
        response.end(JSON.stringify({error:'acceptance relay upstream unavailable'}));
      }
    });
    request.once('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let closing;
  return {
    baseUrl:`http://127.0.0.1:${address.port}`,
    applied,
    events,
    close() {
      if (!closing) closing = new Promise((resolve, reject) => {
        for (const hold of holds) {
          clearInterval(hold.heartbeat);
          clearTimeout(hold.expiry);
          hold.response.destroy();
        }
        for (const upstream of upstreamRequests) upstream.destroy();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// The full production dependency graph and lifecycle hooks are used. Only
// binding to loopback/port 0 and reporting the allocated address are test glue.
const CP_BOOTSTRAP = `
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './dist/app.module.js';
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
process.stdout.write('${READY_PREFIX}' + JSON.stringify({port:app.getHttpServer().address().port}) + '\\n');
`;

async function startCp(label, env, evidenceDir) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CP_BOOTSTRAP], {
    cwd:join(process.cwd(), 'apps/api'), env, stdio:['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let lines = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
  const exited = new Promise(resolve => {
    child.once('error', error => {rejectReady(error); resolve({error:String(error)});});
    child.once('exit', (code, signal) => {
      rejectReady(new Error(`${label} exited before readiness: ${code}/${signal}`));
      resolve({code, signal});
    });
  });
  const record = chunk => {output = (output + chunk.toString()).slice(-128 * 1024);};
  child.stderr.on('data', record);
  child.stdout.on('data', chunk => {
    record(chunk);
    lines += chunk.toString();
    let boundary;
    while ((boundary = lines.indexOf('\n')) !== -1) {
      const line = lines.slice(0, boundary);
      lines = lines.slice(boundary + 1);
      if (line.startsWith(READY_PREFIX)) {
        try {
          const {port} = JSON.parse(line.slice(READY_PREFIX.length));
          assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
          resolveReady(`http://127.0.0.1:${port}`);
        } catch (error) {rejectReady(error);}
      }
    }
  });
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    try {return await bounded(exited, 5000, `${label} did not exit`);}
    catch {
      child.kill('SIGKILL');
      return await bounded(exited, 5000, `${label} survived SIGKILL`);
    } finally {
      if (evidenceDir) writeFileSync(join(evidenceDir, `${label}.log`), output);
    }
  };
  try {
    const baseUrl = await bounded(ready, 60_000, `${label} startup timed out`);
    return {baseUrl, child, exited, stop};
  } catch (error) {
    await stop('SIGKILL');
    throw new Error(`${label} startup failed: ${String(error)}\n${output.slice(-8000)}`);
  }
}

async function api(cp, token, path, body, timeout = 40_000) {
  const response = await fetch(`${cp.baseUrl}${path}`, {
    method:body === undefined ? 'GET' : 'POST',
    headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let json;
  try {json = JSON.parse(text);} catch {throw new Error(`CP returned non-JSON status ${response.status}`);}
  return {status:response.status, body:json};
}

/**
 * Run after OPEN is restored and before topology destruction. This purposely
 * retains the killed owner's admission and SENDING dispatch as immutable
 * evidence; a later maintenance close must resolve them through the admin
 * recovery protocol rather than deleting them in this harness.
 */
export async function runResidentCpAcceptance({db, raw, registry, serviceId, evidenceDir}) {
  assert.equal(process.env.DOCKLANE_OR_MAINTENANCE_ACCEPTANCE, '1', 'resident CP test requires the disposable acceptance harness');
  assert.ok(serviceId && registry.expectedClusterId);
  const operationId = randomUUID();
  const token = `disposable-resident-${randomUUID()}`;
  const actorId = 'resident-cp-acceptance';
  const route = `/v1/clusters/default/services/${serviceId}/restart`;
  const relays = [];
  const processes = [];
  let pending;
  try {
    for (const agent of registry.agents) {
      const relay = await createHeldMutationRelay({
        ...agent, targetUrl:agent.baseUrl,
        holdMutationPath:agent.id === registry.primaryId ? `/v2/services/${serviceId}/restart` : null,
      });
      relays.push({agentId:agent.id, ...relay});
    }
    const env = {
      ...process.env,
      DOCKLANE_CLUSTER_ID:'default',
      DOCKLANE_EXPECTED_CLUSTER_ID:registry.expectedClusterId,
      DOCKLANE_CLUSTER_REGISTRATION_MODE:'enforce',
      DOCKLANE_MAINTENANCE_ENFORCE:'1',
      DOCKLANE_AGENT_INSECURE_DEV:'true',
      DOCKLANE_AGENT_PRIMARY_ID:registry.primaryId,
      DOCKLANE_MANAGER_AGENTS:JSON.stringify(relays.map(x => ({id:x.agentId, baseUrl:x.baseUrl}))),
      DOCKLANE_API_TOKENS:JSON.stringify([{token, actorId, role:'ADMIN', clusters:['default']}]),
    };
    // Start sequentially to avoid making startup migration locking the subject
    // of this test; both complete full bootstrap before concurrent HTTP work.
    const first = await startCp('maintenance-cp-one', env, evidenceDir);
    processes.push(first);
    const survivor = await startCp('maintenance-cp-two', env, evidenceDir);
    processes.push(survivor);
    const [oneRead, twoRead] = await Promise.all(processes.map(cp => api(cp, token, '/v1/clusters/default/maintenance')));
    assert.equal(oneRead.status, 200);
    assert.equal(twoRead.status, 200);
    assert.equal(oneRead.body.state, 'OPEN');
    assert.equal(twoRead.body.generation, oneRead.body.generation);
    const before = await raw.inspectService(serviceId);
    const body = {operationId, expectedVersion:before.service.version};
    // Attach rejection handling immediately: the expected SIGKILL disconnects
    // this outstanding HTTP request and must not become an unhandled rejection.
    pending = api(first, token, route, body).then(
      result => ({result}), error => ({error:String(error)}),
    );
    const primary = relays.find(x => x.agentId === registry.primaryId);
    const applied = await bounded(primary.applied, 20_000, 'CP mutation never reached a successful real Agent response');
    assert.equal(applied.status, 200);
    const rival = await api(survivor, token, route, body, 10_000);
    assert.equal(rival.status, 409, JSON.stringify(rival));
    assert.match(rival.body.message, /Another mutation is in progress for an affected resource/);
    const inFlight = await api(survivor, token, `/v1/clusters/default/operations/${operationId}`);
    assert.equal(inFlight.status, 200);
    assert.ok(['PENDING', 'RUNNING', 'VERIFYING'].includes(inFlight.body.status), 'killed CP must still own a nonterminal operation');
    const [dispatchBefore] = await db.query(
      'SELECT id, phase FROM maintenance_dispatches WHERE cluster_id=? AND operation_id=?',
      ['default', operationId],
    );
    assert.equal(dispatchBefore.length, 1);
    assert.equal(dispatchBefore[0].phase, 'SENDING', 'crash must occur before CP processes the held ACK');
    const [admissionBefore] = await db.query(
      'SELECT id, owner_id FROM maintenance_active_admissions WHERE cluster_id=? AND operation_id=?',
      ['default', operationId],
    );
    assert.equal(admissionBefore.length, 1);
    const killed = await first.stop('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');
    const disconnected = await bounded(pending, 5000, 'killed CP HTTP request did not disconnect');
    assert.ok(disconnected.error, 'killed CP must not return an acknowledged operation');
    const afterApply = await raw.inspectService(serviceId);
    assert.ok(afterApply.service.version > before.service.version);
    const recovered = await api(survivor, token, route, body);
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(recovered.body.id, operationId);
    assert.equal(recovered.body.status, 'SUCCESS', JSON.stringify(recovered.body));
    const replay = await api(survivor, token, route, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 'SUCCESS');
    const afterRetry = await raw.inspectService(serviceId);
    assert.equal(afterRetry.service.specHash, afterApply.service.specHash);
    assert.equal(afterRetry.service.forceUpdate, afterApply.service.forceUpdate);
    const mutationEvents = relays.flatMap(x => x.events).filter(x => MUTATION_PATH.test(x.path));
    assert.equal(mutationEvents.length, 1, 'survivor recovery and replay must not redispatch any mutation');
    const [dispatchAfter] = await db.query(
      'SELECT id, phase FROM maintenance_dispatches WHERE cluster_id=? AND operation_id=?',
      ['default', operationId],
    );
    assert.deepEqual(dispatchAfter, dispatchBefore, 'observed operation recovery must retain the original SENDING evidence');
    const [admissionAfter] = await db.query(
      'SELECT id, owner_id FROM maintenance_active_admissions WHERE cluster_id=? AND operation_id=?',
      ['default', operationId],
    );
    assert.deepEqual(admissionAfter, admissionBefore, 'killed owner admission must not silently expire');
    return {
      operationId, twoResidentApiProcesses:true, concurrentResourceConflict:rival.status,
      killedSignal:killed.signal, statusBeforeKill:inFlight.body.status, survivorStatus:recovered.body.status,
      beforeVersion:before.service.version, afterApplyVersion:afterApply.service.version,
      afterRecoveryVersion:afterRetry.service.version, mutationRequests:mutationEvents.length,
      dispatchId:dispatchAfter[0].id, dispatchPhase:dispatchAfter[0].phase,
      retainedAdmissionId:admissionAfter[0].id,
      requiresExplicitEvidenceResolution:true,
    };
  } finally {
    // Attempt every cleanup even if one child refuses to stop. Never strand
    // other CPs or relay sockets because an earlier cleanup failed.
    const stopped = await Promise.allSettled(processes.map(cp => cp.stop()));
    const closed = await Promise.allSettled(relays.map(relay => relay.close()));
    const drained = pending
      ? await Promise.allSettled([bounded(pending, 5000, 'resident CP pending request cleanup timed out')])
      : [];
    const failures = [...stopped, ...closed, ...drained].filter(x => x.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(x => x.reason), 'resident CP cleanup failed');
  }
}
