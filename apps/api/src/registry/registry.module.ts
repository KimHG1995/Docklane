import { Module } from '@nestjs/common';
import { EnvRegistryCredentialProvider } from './env-registry-credential.provider.js';
import { RegistryClient } from './registry.client.js';
import { REGISTRY_CREDENTIAL_PROVIDER } from './registry.types.js';

@Module({
  providers: [
    EnvRegistryCredentialProvider,
    {
      provide: REGISTRY_CREDENTIAL_PROVIDER,
      useExisting: EnvRegistryCredentialProvider,
    },
    RegistryClient,
  ],
  exports: [RegistryClient],
})
export class RegistryModule {}
