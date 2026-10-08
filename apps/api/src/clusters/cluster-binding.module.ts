import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import { CLUSTER_BINDING_SETTINGS, ClusterBindingPolicy, loadClusterBindingSettings } from './cluster-binding.policy.js';

@Module({
  imports: [DbModule],
  providers: [
    ClusterRegistrationRepository,
    { provide: CLUSTER_BINDING_SETTINGS, useFactory: loadClusterBindingSettings },
    ClusterBindingPolicy,
  ],
  exports: [ClusterRegistrationRepository, ClusterBindingPolicy],
})
export class ClusterBindingModule {}
