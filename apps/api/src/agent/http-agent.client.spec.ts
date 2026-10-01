import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { HttpAgentClient } from './http-agent.client.js';
import type { ManagerAgentConfig } from './agent-config.js';

type StubAgent = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startStubAgent(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => boolean | void,
): Promise<StubAgent> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (handler(request, response) === true) {
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function unusedLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return `http://127.0.0.1:${address.port}`;
}

function registry(
  agents: Array<{ id: string; baseUrl: string }>,
  primaryId = agents[0]!.id,
): ManagerAgentConfig {
  return {
    primaryId,
    agents: agents.map((agent) => ({
      ...agent,
      insecureDev: true,
    })),
  };
}

function identity(clusterId: string, nodeId: string) {
  return {
    component: 'docklane-agent',
    clusterId,
    nodeId,
    hostname: nodeId,
    manager: true,
    leader: false,
  } as const;
}

function serviceDetail(name = 'svc') {
  return {
    service: {
      id: 'svc',
      name,
      version: 1,
      specHash: 'spec-1',
      forceUpdate: 0,
      mode: 'replicated',
      desiredReplicas: 1,
      runningReplicas: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    tasks: [],
  };
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.end(JSON.stringify(value));
}

test('safe Agent requests fail over from an unavailable primary and stay on the replacement', async () => {
  const primaryUrl = await unusedLoopbackUrl();
  let secondaryIdentityCalls = 0;
  let secondaryHealthCalls = 0;

  const secondary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      secondaryIdentityCalls += 1;
      writeJson(response, identity('cluster-a', 'manager-02'));
      return true;
    }
    if (request.url === '/v1/health') {
      secondaryHealthCalls += 1;
      writeJson(response, {
        status: 'ok',
        component: 'docklane-agent',
      });
      return true;
    }
  });

  try {
    const client = new HttpAgentClient(
      registry([
        { id: 'manager-01', baseUrl: primaryUrl },
        { id: 'manager-02', baseUrl: secondary.baseUrl },
      ]),
    );

    assert.deepEqual(await client.health(), {
      status: 'ok',
      component: 'docklane-agent',
    });
    assert.deepEqual(await client.health(), {
      status: 'ok',
      component: 'docklane-agent',
    });

    assert.equal(secondaryIdentityCalls, 0);
    assert.equal(secondaryHealthCalls, 2);
  } finally {
    await secondary.close();
  }
});

test('failover rejects a manager Agent from a different Swarm cluster', async () => {
  let primaryReadsFail = false;
  let secondaryServiceCalls = 0;
  let tertiaryServiceCalls = 0;

  const primary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      writeJson(response, identity('cluster-a', 'manager-01'));
      return true;
    }
    if (request.url === '/v1/health') {
      writeJson(response, {
        status: 'ok',
        component: 'docklane-agent',
      });
      return true;
    }
    if (request.url === '/v1/services/svc') {
      if (primaryReadsFail) {
        request.socket.destroy();
        return true;
      }
      writeJson(response, serviceDetail('primary'));
      return true;
    }
  });
  const secondary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      writeJson(response, identity('cluster-b', 'manager-02'));
      return true;
    }
    if (request.url === '/v1/services/svc') {
      secondaryServiceCalls += 1;
      writeJson(response, serviceDetail('wrong-cluster'));
      return true;
    }
  });
  const tertiary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      writeJson(response, identity('cluster-a', 'manager-03'));
      return true;
    }
    if (request.url === '/v1/services/svc') {
      tertiaryServiceCalls += 1;
      writeJson(response, serviceDetail('tertiary'));
      return true;
    }
  });

  try {
    const client = new HttpAgentClient(
      registry([
        { id: 'manager-01', baseUrl: primary.baseUrl },
        { id: 'manager-02', baseUrl: secondary.baseUrl },
        { id: 'manager-03', baseUrl: tertiary.baseUrl },
      ]),
    );

    await client.health();
    primaryReadsFail = true;

    const result = await client.inspectService('svc');
    assert.equal(result.service.name, 'tertiary');
    assert.equal(secondaryServiceCalls, 0);
    assert.equal(tertiaryServiceCalls, 1);
  } finally {
    await primary.close();
    await secondary.close();
    await tertiary.close();
  }
});

test('mutation transport failure is not blindly retried on another manager Agent', async () => {
  let primaryMutationCalls = 0;
  let secondaryMutationCalls = 0;
  let secondaryReadCalls = 0;

  const primary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      writeJson(response, identity('cluster-a', 'manager-01'));
      return true;
    }
    if (request.url === '/v1/health') {
      writeJson(response, {
        status: 'ok',
        component: 'docklane-agent',
      });
      return true;
    }
    if (
      request.method === 'POST' &&
      request.url === '/v1/services/svc/scale'
    ) {
      primaryMutationCalls += 1;
      request.socket.destroy();
      return true;
    }
  });
  const secondary = await startStubAgent((request, response) => {
    if (request.url === '/v1/identity') {
      writeJson(response, identity('cluster-a', 'manager-02'));
      return true;
    }
    if (
      request.method === 'POST' &&
      request.url === '/v1/services/svc/scale'
    ) {
      secondaryMutationCalls += 1;
      writeJson(response, {
        serviceId: 'svc',
        version: 2,
        targetSpecHash: 'spec-2',
        targetForceUpdate: 0,
      });
      return true;
    }
    if (request.url === '/v1/services/svc') {
      secondaryReadCalls += 1;
      writeJson(response, serviceDetail('secondary'));
      return true;
    }
  });

  try {
    const client = new HttpAgentClient(
      registry([
        { id: 'manager-01', baseUrl: primary.baseUrl },
        { id: 'manager-02', baseUrl: secondary.baseUrl },
      ]),
    );

    await client.health();

    await assert.rejects(
      client.scaleService('svc', {
        expectedVersion: 1,
        expectedSpecHash: 'spec-1',
        targetSpecHash: 'spec-2',
        replicas: 2,
      }),
      /transport failed/,
    );

    assert.equal(primaryMutationCalls, 1);
    assert.equal(secondaryMutationCalls, 0);

    const reconciledRead = await client.inspectService('svc');
    assert.equal(reconciledRead.service.name, 'secondary');
    assert.equal(secondaryReadCalls, 1);
  } finally {
    await primary.close();
    await secondary.close();
  }
});
