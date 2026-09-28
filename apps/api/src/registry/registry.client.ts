import { Inject, Injectable } from '@nestjs/common';
import { RegistryEndpointPolicy } from './registry-endpoint.policy.js';
import { RegistryRequestError } from './registry.errors.js';
import {
  REGISTRY_CREDENTIAL_PROVIDER,
  type RegistryCredentialProvider,
  type RegistryCredentials,
  type ResolvedRegistryArtifact,
} from './registry.types.js';

const ACCEPT_MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

@Injectable()
export class RegistryClient {
  constructor(
    @Inject(REGISTRY_CREDENTIAL_PROVIDER)
    private readonly credentials: RegistryCredentialProvider,
    @Inject(RegistryEndpointPolicy)
    private readonly endpointPolicy: RegistryEndpointPolicy,
  ) {}

  async resolve(
    imageRepository: string,
    reference: string,
  ): Promise<ResolvedRegistryArtifact> {
    const repository = parseRepository(imageRepository);
    await this.endpointPolicy.assertAllowed(new URL(repository.baseUrl));
    const manifestUrl =
      `${repository.baseUrl}/v2/${encodeRepositoryPath(repository.path)}/manifests/${encodeURIComponent(reference)}`;

    let response = await this.requestManifest(
      manifestUrl,
      repository.host,
      undefined,
    );

    if (response.status === 401) {
      const challenge = parseBearerChallenge(
        response.headers.get('www-authenticate'),
      );
      if (!challenge) {
        throw new RegistryRequestError(
          'AUTHENTICATION_REQUIRED',
          'Registry requires unsupported authentication',
        );
      }

      const token = await this.fetchBearerToken(
        challenge,
        repository.host,
        repository.path,
      );
      response = await this.requestManifest(
        manifestUrl,
        repository.host,
        token,
      );
    }

    mapManifestFailure(response);

    const digest = response.headers.get('docker-content-digest');
    if (!digest || !DIGEST_PATTERN.test(digest)) {
      throw new RegistryRequestError(
        'INVALID_DIGEST',
        'Registry did not return a valid sha256 Docker-Content-Digest',
      );
    }

    if (DIGEST_PATTERN.test(reference) && digest.toLowerCase() !== reference.toLowerCase()) {
      throw new RegistryRequestError(
        'INVALID_DIGEST',
        'Registry manifest digest does not match requested digest',
      );
    }

    const contentLength = parseContentLength(
      response.headers.get('content-length'),
    );

    return {
      repository: imageRepository,
      reference,
      digest: digest.toLowerCase(),
      mediaType: response.headers.get('content-type'),
      contentLength,
    };
  }

  private requestManifest(
    url: string,
    registryHost: string,
    bearerToken: string | undefined,
  ): Promise<Response> {
    const headers = new Headers({
      Accept: ACCEPT_MANIFESTS,
    });

    if (bearerToken) {
      headers.set('Authorization', `Bearer ${bearerToken}`);
    } else {
      const credential = this.credentials.credentialsFor(registryHost);
      if (credential) {
        headers.set('Authorization', basicAuthorization(credential));
      }
    }

    return this.safeFetch(url, {
      method: 'HEAD',
      headers,
    });
  }

  private async safeFetch(
    input: string,
    init: { method: string; headers: Headers },
  ): Promise<Response> {
    let current = new URL(input);
    let headers = new Headers(init.headers);

    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await this.endpointPolicy.assertAllowed(current);

      let response: Response;
      try {
        response = await fetch(current, {
          method: init.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new RegistryRequestError(
          'REGISTRY_UNAVAILABLE',
          error instanceof Error ? error.message : String(error),
        );
      }

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new RegistryRequestError(
          'REGISTRY_UNAVAILABLE',
          'Registry redirect did not include a Location header',
        );
      }

      const next = new URL(location, current);
      await this.endpointPolicy.assertAllowed(next);
      if (next.origin !== current.origin) {
        headers = new Headers(headers);
        headers.delete('authorization');
      }
      current = next;
    }

    throw new RegistryRequestError(
      'REGISTRY_UNAVAILABLE',
      'Registry exceeded the redirect limit',
    );
  }

  private async fetchBearerToken(
    challenge: BearerChallenge,
    registryHost: string,
    repositoryPath: string,
  ): Promise<string> {
    let url: URL;
    try {
      url = new URL(challenge.realm);
    } catch {
      throw new RegistryRequestError(
        'AUTHENTICATION_REQUIRED',
        'Registry returned an invalid authentication realm',
      );
    }

    await this.endpointPolicy.assertAllowed(url);

    if (challenge.service) {
      url.searchParams.set('service', challenge.service);
    }
    url.searchParams.set(
      'scope',
      challenge.scope ?? `repository:${repositoryPath}:pull`,
    );

    const headers = new Headers();
    const credential = this.credentials.credentialsFor(registryHost);
    if (credential) {
      headers.set('Authorization', basicAuthorization(credential));
    }

    const response = await this.safeFetch(url.toString(), {
      method: 'GET',
      headers,
    });

    if (response.status === 401) {
      throw new RegistryRequestError(
        'AUTHENTICATION_REQUIRED',
        'Registry credentials were rejected by the token service',
      );
    }
    if (response.status === 403) {
      throw new RegistryRequestError(
        'ACCESS_DENIED',
        'Registry token service denied repository access',
      );
    }
    if (!response.ok) {
      throw new RegistryRequestError(
        'REGISTRY_UNAVAILABLE',
        `Registry token service returned HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RegistryRequestError(
        'AUTHENTICATION_REQUIRED',
        'Registry token service returned invalid JSON',
      );
    }

    const token = readToken(body);
    if (!token) {
      throw new RegistryRequestError(
        'AUTHENTICATION_REQUIRED',
        'Registry token response did not contain a token',
      );
    }
    return token;
  }
}

interface ParsedRepository {
  host: string;
  path: string;
  baseUrl: string;
}

interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

function parseRepository(value: string): ParsedRepository {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('@')) {
    throw new RegistryRequestError(
      'INVALID_REPOSITORY',
      'imageRepository must not include a digest',
    );
  }

  let url: URL;
  try {
    url = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new RegistryRequestError(
      'INVALID_REPOSITORY',
      'imageRepository is invalid',
    );
  }

  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!url.hostname || !path || url.search || url.hash) {
    throw new RegistryRequestError(
      'INVALID_REPOSITORY',
      'imageRepository must be registry-host/repository-path',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RegistryRequestError(
      'INVALID_REPOSITORY',
      'Registry protocol must be HTTP or HTTPS',
    );
  }

  return {
    host: url.host.toLowerCase(),
    path,
    baseUrl: `${url.protocol}//${url.host}`,
  };
}

function encodeRepositoryPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function basicAuthorization(credentials: RegistryCredentials): string {
  return `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString('base64')}`;
}

function parseBearerChallenge(
  header: string | null,
): BearerChallenge | null {
  if (!header || !/^Bearer\s+/i.test(header)) return null;

  const params = new Map<string, string>();
  const body = header.replace(/^Bearer\s+/i, '');
  for (const match of body.matchAll(
    /([a-zA-Z][a-zA-Z0-9_-]*)="((?:[^"\\]|\\.)*)"/g,
  )) {
    params.set(match[1].toLowerCase(), match[2].replace(/\\(.)/g, '$1'));
  }

  const realm = params.get('realm');
  if (!realm) return null;

  return {
    realm,
    service: params.get('service'),
    scope: params.get('scope'),
  };
}

function readToken(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('token' in value && typeof value.token === 'string') return value.token;
  if (
    'access_token' in value &&
    typeof value.access_token === 'string'
  ) {
    return value.access_token;
  }
  return null;
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mapManifestFailure(response: Response): void {
  if (response.ok) return;
  if (response.status === 401) {
    throw new RegistryRequestError(
      'AUTHENTICATION_REQUIRED',
      'Registry authentication is required',
    );
  }
  if (response.status === 403) {
    throw new RegistryRequestError(
      'ACCESS_DENIED',
      'Registry access was denied',
    );
  }
  if (response.status === 404) {
    throw new RegistryRequestError(
      'MANIFEST_NOT_FOUND',
      'Registry manifest was not found',
    );
  }
  if (response.status === 429) {
    throw new RegistryRequestError(
      'RATE_LIMITED',
      'Registry rate limit exceeded',
    );
  }
  throw new RegistryRequestError(
    'REGISTRY_UNAVAILABLE',
    `Registry returned HTTP ${response.status}`,
  );
}


