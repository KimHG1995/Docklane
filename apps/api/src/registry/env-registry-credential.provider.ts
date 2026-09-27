import { Injectable } from '@nestjs/common';
import type {
  RegistryCredentialProvider,
  RegistryCredentials,
} from './registry.types.js';

@Injectable()
export class EnvRegistryCredentialProvider
  implements RegistryCredentialProvider
{
  private readonly credentials = parseCredentials(
    process.env.DOCKLANE_REGISTRY_AUTH_JSON,
  );

  credentialsFor(registryHost: string): RegistryCredentials | null {
    return this.credentials.get(registryHost.toLowerCase()) ?? null;
  }
}

function parseCredentials(
  raw: string | undefined,
): Map<string, RegistryCredentials> {
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DOCKLANE_REGISTRY_AUTH_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'DOCKLANE_REGISTRY_AUTH_JSON must be an object keyed by registry host',
    );
  }

  const result = new Map<string, RegistryCredentials>();
  for (const [host, value] of Object.entries(parsed)) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('username' in value) ||
      !('password' in value) ||
      typeof value.username !== 'string' ||
      typeof value.password !== 'string'
    ) {
      throw new Error(
        `Invalid registry credentials for host ${host}`,
      );
    }
    result.set(host.toLowerCase(), {
      username: value.username,
      password: value.password,
    });
  }
  return result;
}
