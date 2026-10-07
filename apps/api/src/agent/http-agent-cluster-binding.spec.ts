import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { loadManagerAgentConfig, type ManagerAgentConfig } from './agent-config.js';
import { HttpAgentClient } from './http-agent.client.js';

const ENV_KEYS = [
  'DOCKLANE_AGENT_INSECURE_DEV', 'DOCKLANE_AGENT_URL',
  'DOCKLANE_AGENT_PRIMARY_ID', 'DOCKLANE_MANAGER_AGENTS',
  'DOCKLANE_AGENT_CA_FILE', 'DOCKLANE_AGENT_CERT_FILE',
  'DOCKLANE_AGENT_KEY_FILE', 'DOCKLANE_EXPECTED_CLUSTER_ID', 'DOCKLANE_CLUSTER_ID',
] as const;

function withEnv(values: Record<string, string>, work: () => void): void {
  const before = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    work();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type PinnedConfig = ManagerAgentConfig & { expectedClusterId?: string };

function registry(urls: string[], expectedClusterId?: string): PinnedConfig {
  return {
    primaryId: 'manager-0', expectedClusterId,
    agents: urls.map((baseUrl, index) => ({
      id: `manager-${index}`, baseUrl, insecureDev: true,
    })),
  };
}

async function startAgent(t: TestContext, clusterId = 'cluster-a') {
  const state = { clusterId, identities: 0, reads: 0, writes: 0, health: 0,
    loseMutationResponse: false, headers: [] as Array<string | undefined> };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/identity') {
      state.identities++;
      response.end(JSON.stringify({
        component: 'docklane-agent', clusterId: state.clusterId,
        nodeId: 'manager-node', hostname: 'manager-host', manager: true, leader: true,
      }));
    } else if (request.url === '/v1/health') {
      state.health++;
      response.end(JSON.stringify({ status: 'ok', component: 'docklane-agent' }));
    } else if (request.url === '/v1/services') {
      state.reads++;
      response.end('[]');
    } else if (request.method === 'POST' && request.url === '/v2/services/svc/scale') {
      state.writes++;
      state.headers.push(request.headers['x-docklane-expected-cluster-id'] as string | undefined);
      request.resume();
      if (state.loseMutationResponse) { request.socket.destroy(); return; }
      response.end(JSON.stringify({ serviceId: 'svc', version: 2,
        targetSpecHash: 'after', targetForceUpdate: 0 }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const scaleInput = { expectedVersion: 1, expectedSpecHash: 'before',
  targetSpecHash: 'after', replicas: 2 };

test('secure environment requires an operator-selected cluster before reading credentials', () => {
  for (const mode of [undefined, 'false']) {
    withEnv({ ...(mode === undefined ? {} : { DOCKLANE_AGENT_INSECURE_DEV: mode }),
      DOCKLANE_AGENT_CA_FILE: '/missing/must-not-read-ca' }, () => {
      assert.throws(() => loadManagerAgentConfig(), /DOCKLANE_EXPECTED_CLUSTER_ID/);
    });
  }
});

test('configured cluster is preserved in secure and development registry loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docklane-binding-'));
  const file = join(dir, 'fixture.pem');
  // Config reads these bytes; TLS certificate validity is checked by the mTLS PoC.
  writeFileSync(file, 'configuration-test-only');
  try {
    for (const mode of ['true', 'false']) {
      withEnv({ DOCKLANE_AGENT_INSECURE_DEV: mode, DOCKLANE_EXPECTED_CLUSTER_ID: 'cluster-A_1',
        DOCKLANE_AGENT_CA_FILE: file, DOCKLANE_AGENT_CERT_FILE: file,
        DOCKLANE_AGENT_KEY_FILE: file }, () => {
        const config: PinnedConfig = loadManagerAgentConfig();
        assert.equal(config.expectedClusterId, 'cluster-A_1');
        assert.equal(config.agents[0]!.insecureDev, mode === 'true');
      });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit malformed cluster settings are never treated as development discovery', () => {
  for (const value of ['', ' ', 'cluster-a\n', 'cluster-a\r', 'cluster-a,cluster-b',
    'a/b', '한글', 'a'.repeat(129)]) {
    withEnv({ DOCKLANE_AGENT_INSECURE_DEV: 'true', DOCKLANE_EXPECTED_CLUSTER_ID: value }, () => {
      assert.throws(() => loadManagerAgentConfig(), /DOCKLANE_EXPECTED_CLUSTER_ID/);
    });
  }
});

test('pinning does not bypass existing mTLS credential requirements', () => {
  withEnv({ DOCKLANE_EXPECTED_CLUSTER_ID: 'cluster-a' }, () => {
    assert.throws(() => loadManagerAgentConfig(), /mTLS files are required/);
  });
});

test('injected secure or mixed registries cannot bypass the required cluster setting', () => {
  const secure = { id: 'secure', baseUrl: 'https://127.0.0.1:9443', insecureDev: false };
  const development = { id: 'dev', baseUrl: 'http://127.0.0.1:9444', insecureDev: true };
  for (const agents of [[secure], [development, secure]]) {
    assert.throws(() => new HttpAgentClient({ primaryId: agents[0]!.id, agents }),
      /DOCKLANE_EXPECTED_CLUSTER_ID/);
  }
  for (const value of ['', 'cluster-a\n', 'a'.repeat(129), null, 1, ['cluster-a']]) {
    const config = { ...registry([development.baseUrl]), expectedClusterId: value };
    assert.throws(() => new HttpAgentClient(config as PinnedConfig),
      /DOCKLANE_EXPECTED_CLUSTER_ID/);
  }
});

test('first connection rejects foreign-cluster reads and mutations even after healthy liveness', async (t) => {
  const foreign = await startAgent(t, 'cluster-b');
  const client = new HttpAgentClient(registry([foreign.url], 'cluster-a'));
  assert.equal((await client.health()).status, 'ok');
  await assert.rejects(client.listServices(), /does not match cluster-a/);
  await assert.rejects(client.scaleService('svc', scaleInput), /does not match cluster-a/);
  assert.equal(foreign.state.reads, 0);
  assert.equal(foreign.state.writes, 0);
});

test('first failover selects the configured cluster rather than pinning the first responder', async (t) => {
  const foreign = await startAgent(t, 'cluster-b');
  const expected = await startAgent(t);
  const client = new HttpAgentClient(registry([foreign.url, expected.url], 'cluster-a'));
  await client.scaleService('svc', scaleInput);
  assert.equal(foreign.state.writes, 0);
  assert.equal(expected.state.writes, 1);
  assert.deepEqual(expected.state.headers, ['cluster-a']);
});

test('failed identity never replaces the configured binding and the expected cluster can recover', async (t) => {
  const agent = await startAgent(t, 'cluster-b');
  const client = new HttpAgentClient(registry([agent.url], 'cluster-a'));
  await assert.rejects(client.identity(), /does not match cluster-a/);
  agent.state.clusterId = 'cluster-a';
  assert.equal((await client.identity()).clusterId, 'cluster-a');
  await client.scaleService('svc', scaleInput);
  assert.deepEqual(agent.state.headers, ['cluster-a']);
});

test('a fresh Node process retains the configured cluster after the endpoint changes', async (t) => {
  const agent = await startAgent(t);
  const env = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  Object.assign(env, { DOCKLANE_AGENT_INSECURE_DEV: 'true',
    DOCKLANE_EXPECTED_CLUSTER_ID: 'cluster-a', DOCKLANE_AGENT_URL: agent.url });
  const moduleUrl = new URL('./http-agent.client.js', import.meta.url).href;
  const run = promisify(execFile);
  async function invoke(action: 'read' | 'mutation') {
    const code = `
      const { HttpAgentClient } = await import(${JSON.stringify(moduleUrl)});
      try {
        const client = new HttpAgentClient();
        const result = ${action === 'read' ? 'await client.listServices()'
          : `await client.scaleService('svc', ${JSON.stringify(scaleInput)})`};
        process.stdout.write(JSON.stringify(result));
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    return run(process.execPath, [...process.execArgv, '--input-type=module', '-e', code],
      { env, timeout: 15_000, maxBuffer: 64 * 1024 });
  }
  assert.equal((await invoke('read')).stdout, '[]');
  agent.state.clusterId = 'cluster-b';
  await assert.rejects(invoke('mutation'), /does not match cluster-a/);
  assert.equal(agent.state.reads, 1);
  assert.equal(agent.state.writes, 0);
});

test('explicit binding is snapshotted and not repinned by later registry changes', async (t) => {
  const agent = await startAgent(t, 'cluster-b');
  const config = registry([agent.url], 'cluster-a');
  const client = new HttpAgentClient(config);
  config.expectedClusterId = 'cluster-b';
  await assert.rejects(client.identity(), /does not match cluster-a/);
  assert.equal(agent.state.writes, 0);
});

test('configured binding preserves the ban on mutation resend after response loss', async (t) => {
  const primary = await startAgent(t);
  const secondary = await startAgent(t);
  primary.state.loseMutationResponse = true;
  const client = new HttpAgentClient(registry([primary.url, secondary.url], 'cluster-a'));
  await assert.rejects(client.scaleService('svc', scaleInput), /transport failed/);
  assert.equal(primary.state.writes, 1);
  assert.equal(secondary.state.writes, 0);
  await client.listServices();
  assert.equal(secondary.state.reads, 1);
});

test('explicit insecure development without a binding preserves first-identity discovery', async (t) => {
  const agent = await startAgent(t);
  const client = new HttpAgentClient(registry([agent.url]));
  await client.listServices();
  agent.state.clusterId = 'cluster-b';
  await assert.rejects(client.listServices(), /does not match cluster-a/);
  assert.equal(agent.state.reads, 1);
  withEnv({ DOCKLANE_AGENT_INSECURE_DEV: 'true' }, () => {
    const config: PinnedConfig = loadManagerAgentConfig();
    assert.equal(config.expectedClusterId, undefined);
  });
});

test('logical API cluster aliases do not supply an actual Swarm cluster binding', () => {
  withEnv({ DOCKLANE_CLUSTER_ID: 'default' }, () => {
    assert.throws(() => loadManagerAgentConfig(), /DOCKLANE_EXPECTED_CLUSTER_ID/);
  });
});

test('configured cluster identifiers preserve valid length boundaries without normalization', () => {
  for (const value of ['a', 'A'.repeat(128), 'Cluster_A-1']) {
    withEnv({ DOCKLANE_AGENT_INSECURE_DEV: 'true', DOCKLANE_EXPECTED_CLUSTER_ID: value }, () => {
      const config: PinnedConfig = loadManagerAgentConfig();
      assert.equal(config.expectedClusterId, value);
    });
  }
});
