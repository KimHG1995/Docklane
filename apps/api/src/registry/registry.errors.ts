export class RegistryRequestError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REPOSITORY'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCESS_DENIED'
      | 'MANIFEST_NOT_FOUND'
      | 'RATE_LIMITED'
      | 'INVALID_DIGEST'
      | 'REGISTRY_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryRequestError';
  }
}
