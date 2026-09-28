import test from 'node:test';
import assert from 'node:assert/strict';
import { RegistryClient } from './registry.client.js';

test('registry client resolves tag through bearer challenge', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      authorization: headers.get('authorization'),
    });

    if (calls.length === 1) {
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:team/api:pull"',
        },
      });
    }

    if (calls.length === 2) {
      return Response.json({ token: 'registry-token' });
    }

    return new Response(null, {
      status: 200,
      headers: {
        'docker-content-digest': digest,
        'content-type': 'application/vnd.oci.image.manifest.v1+json',
        'content-length': '123',
      },
    });
  }) as typeof fetch;

  try {
    const client = new RegistryClient(
      { credentialsFor: () => null },
      { assertAllowed: async () => undefined } as never,
    );

    const result = await client.resolve(
      'registry.example.com/team/api',
      'latest',
    );

    assert.equal(result.digest, digest);
    assert.equal(result.contentLength, 123);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'HEAD');
    assert.match(calls[1].url, /scope=repository%3Ateam%2Fapi%3Apull/);
    assert.equal(calls[2].authorization, 'Bearer registry-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registry client uses configured basic credentials for token service', async () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const originalFetch = globalThis.fetch;
  const authHeaders: Array<string | null> = [];

  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    authHeaders.push(headers.get('authorization'));

    if (authHeaders.length === 1) {
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.example.com/token",service="registry.example.com"',
        },
      });
    }

    if (authHeaders.length === 2) {
      return Response.json({ access_token: 'private-token' });
    }

    return new Response(null, {
      status: 200,
      headers: {
        'docker-content-digest': digest,
      },
    });
  }) as typeof fetch;

  try {
    const client = new RegistryClient(
      {
        credentialsFor: () => ({
          username: 'docklane',
          password: 'secret',
        }),
      },
      { assertAllowed: async () => undefined } as never,
    );

    await client.resolve('registry.example.com/team/api', '1.0.0');

    const basic = `Basic ${Buffer.from('docklane:secret').toString('base64')}`;
    assert.equal(authHeaders[0], basic);
    assert.equal(authHeaders[1], basic);
    assert.equal(authHeaders[2], 'Bearer private-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registry client rejects digest mismatch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(null, {
      status: 200,
      headers: {
        'docker-content-digest': `sha256:${'e'.repeat(64)}`,
      },
    })) as typeof fetch;

  try {
    const client = new RegistryClient(
      { credentialsFor: () => null },
      { assertAllowed: async () => undefined } as never,
    );

    await assert.rejects(
      client.resolve(
        'registry.example.com/team/api',
        `sha256:${'f'.repeat(64)}`,
      ),
      /does not match/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registry redirect revalidates destination and strips cross-origin authorization', async () => {
  const digest = `sha256:${'9'.repeat(64)}`;
  const originalFetch = globalThis.fetch;
  const seenAuth: Array<string | null> = [];
  const checked: string[] = [];

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seenAuth.push(new Headers(init?.headers).get('authorization'));
    const url = String(input);

    if (url.startsWith('https://registry.example.com/')) {
      return new Response(null, {
        status: 307,
        headers: {
          location: 'https://cdn.example.net/manifests/latest',
        },
      });
    }

    return new Response(null, {
      status: 200,
      headers: {
        'docker-content-digest': digest,
      },
    });
  }) as typeof fetch;

  try {
    const client = new RegistryClient(
      {
        credentialsFor: () => ({
          username: 'docklane',
          password: 'secret',
        }),
      },
      {
        assertAllowed: async (url: URL) => {
          checked.push(url.toString());
        },
      } as never,
    );

    const result = await client.resolve(
      'registry.example.com/team/api',
      'latest',
    );

    assert.equal(result.digest, digest);
    assert.match(seenAuth[0] ?? '', /^Basic /);
    assert.equal(seenAuth[1], null);
    assert.ok(checked.some((url) => url.startsWith('https://cdn.example.net/')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
