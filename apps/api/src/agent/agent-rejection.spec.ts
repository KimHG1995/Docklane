import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRequestError, isDeterministicAgentRejection } from './agent-client.js';

const guards = [
  [412, 'CLUSTER_PRECONDITION_FAILED'],
  [428, 'CLUSTER_PRECONDITION_REQUIRED'],
  [503, 'CLUSTER_IDENTITY_UNAVAILABLE'],
] as const;

test('only the exact Agent admission status/code pairs prove non-execution', () => {
  for (const [status, code] of guards) {
    const error = new AgentRequestError(status, JSON.stringify({ code, error: 'not dispatched' }));
    assert.equal(isDeterministicAgentRejection(error), true);
    assert.equal(error.statusCode, status, 'do not rewrite transport status to a legacy rejection');
    for (const other of [200, 401, 403, 404, 412, 428, 500, 502, 503, 504]) {
      if (other === status) continue;
      assert.equal(isDeterministicAgentRejection(new AgentRequestError(other, error.responseBody)), false,
        `${other}/${code} must remain uncertain`);
    }
  }
});

test('unstructured, malformed, nested and unknown rejection codes are not evidence', () => {
  for (const [status, code] of guards) {
    for (const body of [
      '', 'temporarily unavailable', '{"code":', 'null', 'false', '123', '[]', '{}',
      JSON.stringify(code), JSON.stringify([{ code }]), JSON.stringify({ error: code }),
      JSON.stringify({ nested: { code } }), JSON.stringify({ code: [code] }),
      JSON.stringify({ code: null }), JSON.stringify({ code: { name: code } }),
      JSON.stringify({ code: `${code} ` }), JSON.stringify({ code: code.toLowerCase() }),
      JSON.stringify({ code: 'UNKNOWN_GUARD' }),
    ]) {
      assert.equal(isDeterministicAgentRejection(new AgentRequestError(status, body)), false,
        `${status}/${body}`);
    }
  }
});

test('legacy 400 and 409 remain deterministic without requiring the new envelope', () => {
  for (const status of [400, 409]) {
    for (const body of ['', 'invalid request', '{"error":"stale version"}']) {
      assert.equal(isDeterministicAgentRejection(new AgentRequestError(status, body)), true);
    }
  }
});

test('ordinary errors and lookalike objects cannot release mutation protection', () => {
  for (const value of [undefined, null, '503', new Error('CLUSTER_IDENTITY_UNAVAILABLE'),
    { statusCode: 503, responseBody: '{"code":"CLUSTER_IDENTITY_UNAVAILABLE"}' },
    { statusCode: 400, responseBody: '' }]) {
    assert.equal(isDeterministicAgentRejection(value), false);
  }
});

test('failed parsing never changes the original status or body', () => {
  const error = new AgentRequestError(503, '{"code":"CLUSTER_IDENTITY_UNAVAILABLE"');
  const body = error.responseBody;
  assert.equal(isDeterministicAgentRejection(error), false);
  assert.equal(error.responseBody, body);
  assert.equal(error.statusCode, 503);
});
