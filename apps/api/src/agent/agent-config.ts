import { readFileSync } from 'node:fs';
import { z } from 'zod';

const AgentConfigSchema = z.object({
  baseUrl: z.string().url(),
  insecureDev: z.boolean(),
  ca: z.instanceof(Buffer).optional(),
  cert: z.instanceof(Buffer).optional(),
  key: z.instanceof(Buffer).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

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

export function loadAgentConfig(): AgentConfig {
  const insecureDev = process.env.DOCKLANE_AGENT_INSECURE_DEV === 'true';
  const config = AgentConfigSchema.parse({
    baseUrl:
      process.env.DOCKLANE_AGENT_URL ??
      (insecureDev ? 'http://127.0.0.1:9443' : 'https://127.0.0.1:9443'),
    insecureDev,
    ca: optionalFile(process.env.DOCKLANE_AGENT_CA_FILE),
    cert: optionalFile(process.env.DOCKLANE_AGENT_CERT_FILE),
    key: optionalFile(process.env.DOCKLANE_AGENT_KEY_FILE),
  });

  const url = new URL(config.baseUrl);

  if (config.insecureDev) {
    if (url.protocol !== 'http:') {
      throw new Error('Insecure Agent mode must use http://');
    }
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error('Insecure Agent mode is restricted to loopback');
    }
    return config;
  }

  if (url.protocol !== 'https:') {
    throw new Error('Secure Agent mode requires https://');
  }
  if (!config.ca || !config.cert || !config.key) {
    throw new Error('Docklane Agent mTLS files are required in secure mode');
  }

  return config;
}
