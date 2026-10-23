import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeldMutationRelay } from './maintenance-resident-cp.mjs';

test('relay holds only a successful mutation after upstream apply and keeps reads available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docklane-resident-relay-'));
  let upstream;
  let relay;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], {stdio:'ignore'});
    const key = readFileSync(join(dir, 'key.pem'));
    const cert = readFileSync(join(dir, 'cert.pem'));
    const calls = [];
    upstream = createServer({key, cert}, (req, res) => {
      calls.push(req.url);
      res.writeHead(req.url === '/v2/services/rejected/restart' ? 409 : 200, {'content-type':'application/json'});
      res.end(JSON.stringify({path:req.url, applied:req.method === 'POST'}));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    relay = await createHeldMutationRelay({
      targetUrl:`https://127.0.0.1:${upstream.address().port}`, cert, key, ca:cert,
      holdMutationPath:'/v2/services/owned/restart',
    });
    const rejected = await fetch(`${relay.baseUrl}/v2/services/rejected/restart`, {method:'POST', body:'{}'});
    assert.equal(rejected.status, 409);
    await rejected.text();
    const response = await fetch(`${relay.baseUrl}/v2/services/owned/restart`, {method:'POST', body:'{}'});
    const event = await relay.applied;
    assert.equal(event.path, '/v2/services/owned/restart');
    assert.equal(event.status, 200);
    assert.ok(calls.includes(event.path), 'apply must happen before the hold signal');
    let completed = false;
    const body = response.text().then(() => {completed = true;}, () => {});
    const read = await fetch(`${relay.baseUrl}/v1/identity`);
    assert.deepEqual(await read.json(), {path:'/v1/identity', applied:false});
    assert.equal(completed, false, 'successful mutation body must still be held');
    await relay.close();
    await body;
    assert.equal(relay.events.filter(x => x.held).length, 1);
  } finally {
    if (relay) await relay.close();
    if (upstream) await new Promise(resolve => {upstream.close(resolve); upstream.closeAllConnections();});
    rmSync(dir, {recursive:true, force:true});
  }
});
