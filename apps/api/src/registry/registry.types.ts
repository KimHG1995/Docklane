export interface RegistryCredentials {
  username: string;
  password: string;
}

export interface ResolvedRegistryArtifact {
  repository: string;
  reference: string;
  digest: string;
  mediaType: string | null;
  contentLength: number | null;
}

export interface RegistryCredentialProvider {
  credentialsFor(registryHost: string): RegistryCredentials | null;
}

export const REGISTRY_CREDENTIAL_PROVIDER = Symbol(
  'REGISTRY_CREDENTIAL_PROVIDER',
);
