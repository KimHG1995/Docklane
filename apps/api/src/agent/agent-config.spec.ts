import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAgentConfig,
  loadManagerAgentConfig,
} from './agent-config.js';

const ENV_KEYS = [
  'DOCKLANE_AGENT_INSECURE_DEV',
  'DOCKLANE_AGENT_URL',
  'DOCKLANE_AGENT_PRIMARY_ID',
  'DOCKLANE_MANAGER_AGENTS',
  'DOCKLANE_AGENT_CA_FILE',
  'DOCKLANE_AGENT_CERT_FILE',
  'DOCKLANE_AGENT_KEY_FILE',
] as const;

function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  work: () => void,
): void {
  const before = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;

  try {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    work();
  } finally {
    for (const key of ENV_KEYS) {
      const value = before[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('manager Agent config selects an explicit primary endpoint', () => {
  withEnv(
    {
      DOCKLANE_AGENT_INSECURE_DEV: 'true',
      DOCKLANE_MANAGER_AGENTS: JSON.stringify([
        {
          id: 'manager-01',
          baseUrl: 'http://127.0.0.1:9443',
        },
        {
          id: 'manager-02',
          baseUrl: 'http://127.0.0.1:9444',
        },
        {
          id: 'manager-03',
          baseUrl: 'http://127.0.0.1:9445',
        },
      ]),
      DOCKLANE_AGENT_PRIMARY_ID: 'manager-02',
    },
    () => {
      const config = loadManagerAgentConfig();
      assert.equal(config.primaryId, 'manager-02');
      assert.deepEqual(
        config.agents.map((agent) => agent.id),
        ['manager-01', 'manager-02', 'manager-03'],
      );
      assert.equal(loadAgentConfig().baseUrl, 'http://127.0.0.1:9444');
    },
  );
});

test('manager Agent config preserves legacy single endpoint compatibility', () => {
  withEnv(
    {
      DOCKLANE_AGENT_INSECURE_DEV: 'true',
      DOCKLANE_AGENT_URL: 'http://127.0.0.1:9555',
    },
    () => {
      const config = loadManagerAgentConfig();
      assert.equal(config.primaryId, 'primary');
      assert.equal(config.agents.length, 1);
      assert.equal(config.agents[0]!.baseUrl, 'http://127.0.0.1:9555');
    },
  );
});

test('manager Agent config rejects duplicate ids and urls', () => {
  withEnv(
    {
      DOCKLANE_AGENT_INSECURE_DEV: 'true',
      DOCKLANE_MANAGER_AGENTS: JSON.stringify([
        { id: 'manager-01', baseUrl: 'http://127.0.0.1:9443' },
        { id: 'manager-01', baseUrl: 'http://127.0.0.1:9444' },
      ]),
    },
    () => {
      assert.throws(
        () => loadManagerAgentConfig(),
        /Duplicate manager Agent id/,
      );
    },
  );

  withEnv(
    {
      DOCKLANE_AGENT_INSECURE_DEV: 'true',
      DOCKLANE_MANAGER_AGENTS: JSON.stringify([
        { id: 'manager-01', baseUrl: 'http://127.0.0.1:9443' },
        { id: 'manager-02', baseUrl: 'http://127.0.0.1:9443' },
      ]),
    },
    () => {
      assert.throws(
        () => loadManagerAgentConfig(),
        /Duplicate manager Agent baseUrl/,
      );
    },
  );
});

test('manager Agent config rejects an unknown primary id', () => {
  withEnv(
    {
      DOCKLANE_AGENT_INSECURE_DEV: 'true',
      DOCKLANE_MANAGER_AGENTS: JSON.stringify([
        { id: 'manager-01', baseUrl: 'http://127.0.0.1:9443' },
      ]),
      DOCKLANE_AGENT_PRIMARY_ID: 'manager-02',
    },
    () => {
      assert.throws(
        () => loadManagerAgentConfig(),
        /does not match a configured manager Agent/,
      );
    },
  );
});
