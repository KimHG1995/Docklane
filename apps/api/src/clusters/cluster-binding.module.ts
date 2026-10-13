import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import { MaintenanceDispatchEvidence } from './maintenance-dispatch-evidence.js';
import { ClusterMaintenanceRepository } from './cluster-maintenance.repository.js';
import { ClusterMaintenanceController } from './cluster-maintenance.controller.js';
import { CLUSTER_BINDING_SETTINGS, ClusterBindingPolicy, loadClusterBindingSettings } from './cluster-binding.policy.js';

@Module({
  imports: [DbModule],
  controllers: [ClusterMaintenanceController],
  providers: [
    ClusterMaintenanceRepository,
    MaintenanceDispatchEvidence,
    ClusterRegistrationRepository,
    { provide: CLUSTER_BINDING_SETTINGS, useFactory: loadClusterBindingSettings },
    ClusterBindingPolicy,
  ],
  exports: [ClusterRegistrationRepository, ClusterBindingPolicy],
})
export class ClusterBindingModule {}
