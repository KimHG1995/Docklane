import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthVerifier } from './health-verifier.js';

test('health verifier requires a continuous stable success window', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    if (calls === 2) {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const verifier = new HealthVerifier({
      assertAllowed: async () => undefined,
    } as never);
    await verifier.verify({
      url: 'https://health.example.com/ready',
      intervalMs: 2,
      timeoutMs: 20,
      retries: 2,
      stabilityWindowMs: 5,
      expectedStatus: 200,
    });
    assert.ok(calls >= 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health verifier rejects credential-bearing URLs', async () => {
  const verifier = new HealthVerifier({
    assertAllowed: async () => {
      throw new Error('Health URL must not contain credentials');
    },
  } as never);
  await assert.rejects(
    verifier.verify({
      url: 'https://user:pass@health.example.com/ready',
      intervalMs: 1,
      timeoutMs: 20,
      retries: 0,
      stabilityWindowMs: 1,
      expectedStatus: 200,
    }),
    /must not contain credentials/,
  );
});
