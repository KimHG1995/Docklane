import { readFileSync } from 'node:fs';
import { z } from 'zod';

const AgentConfigSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
  insecureDev: z.boolean(),
  ca: z.instanceof(Buffer).optional(),
  cert: z.instanceof(Buffer).optional(),
  key: z.instanceof(Buffer).optional(),
});

const ManagerAgentDefinitionSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
}).strict();

const ManagerAgentDefinitionsSchema = z.array(
  ManagerAgentDefinitionSchema,
).min(1);

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export interface ManagerAgentConfig {
  primaryId: string;
  agents: AgentConfig[];
}

export const MANAGER_AGENT_CONFIG = Symbol('MANAGER_AGENT_CONFIG');

function optionalFile(path: string | undefined): Buffer | undefined {
  return path ? readFileSync(path) : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function parseManagerDefinitions(
  raw: string | undefined,
  fallback: { id: string; baseUrl: string },
): Array<{ id: string; baseUrl: string }> {
  if (!raw) {
    return [fallback];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `DOCKLANE_MANAGER_AGENTS must be valid JSON: ${String(error)}`,
    );
  }

  return ManagerAgentDefinitionsSchema.parse(parsed);
}

function validateTransport(config: AgentConfig): void {
  const url = new URL(config.baseUrl);

  if (config.insecureDev) {
    if (url.protocol !== 'http:') {
      throw new Error('Insecure Agent mode must use http://');
    }
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error('Insecure Agent mode is restricted to loopback');
    }
    return;
  }

  if (url.protocol !== 'https:') {
    throw new Error('Secure Agent mode requires https://');
  }
  if (!config.ca || !config.cert || !config.key) {
    throw new Error('Docklane Agent mTLS files are required in secure mode');
  }
}

export function loadManagerAgentConfig(): ManagerAgentConfig {
  const insecureDev = process.env.DOCKLANE_AGENT_INSECURE_DEV === 'true';
  const primaryOverride = process.env.DOCKLANE_AGENT_PRIMARY_ID;
  const fallbackId = primaryOverride ?? 'primary';
  const fallbackUrl =
    process.env.DOCKLANE_AGENT_URL ??
    (insecureDev ? 'http://127.0.0.1:9443' : 'https://127.0.0.1:9443');

  const definitions = parseManagerDefinitions(
    process.env.DOCKLANE_MANAGER_AGENTS,
    {
      id: fallbackId,
      baseUrl: fallbackUrl,
    },
  );

  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(
        `Duplicate manager Agent id: ${definition.id}`,
      );
    }
    if (urls.has(definition.baseUrl)) {
      throw new Error(
        `Duplicate manager Agent baseUrl: ${definition.baseUrl}`,
      );
    }
    ids.add(definition.id);
    urls.add(definition.baseUrl);
  }

  const ca = optionalFile(process.env.DOCKLANE_AGENT_CA_FILE);
  const cert = optionalFile(process.env.DOCKLANE_AGENT_CERT_FILE);
  const key = optionalFile(process.env.DOCKLANE_AGENT_KEY_FILE);

  const agents = definitions.map((definition) =>
    AgentConfigSchema.parse({
      ...definition,
      insecureDev,
      ca,
      cert,
      key,
    }),
  );

  for (const agent of agents) {
    validateTransport(agent);
  }

  const primaryId = primaryOverride ?? agents[0]!.id;
  if (!ids.has(primaryId)) {
    throw new Error(
      `DOCKLANE_AGENT_PRIMARY_ID does not match a configured manager Agent: ${primaryId}`,
    );
  }

  return {
    primaryId,
    agents,
  };
}

export function loadAgentConfig(): AgentConfig {
  const config = loadManagerAgentConfig();
  const primary = config.agents.find(
    (agent) => agent.id === config.primaryId,
  );
  if (!primary) {
    throw new Error('Primary manager Agent configuration disappeared');
  }
  return primary;
}
