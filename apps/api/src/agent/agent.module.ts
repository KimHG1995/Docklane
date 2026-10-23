import { Module } from '@nestjs/common';
import { AGENT_CLIENT } from './agent-client.js';
import {
  MANAGER_AGENT_CONFIG,
  loadManagerAgentConfig,
} from './agent-config.js';
import { HttpAgentClient } from './http-agent.client.js';
import { ClusterBindingModule } from '../clusters/cluster-binding.module.js';
import { ClusterBindingPolicy } from '../clusters/cluster-binding.policy.js';
import { Database } from '../db/database.js';
import { OperationLock } from '../operations/operation-lock.js';
import { RegisteredOperationLock } from '../clusters/registered-operation-lock.js';
import { MaintenanceDispatchJournal } from '../clusters/maintenance-dispatch-journal.js';
import { MaintenanceManagerBarrier } from '../clusters/maintenance-manager-barrier.js';
import { MaintenanceCloseController } from '../clusters/maintenance-close.controller.js';
import { MaintenanceRecoveryController } from '../clusters/maintenance-recovery.controller.js';
import { MaintenanceEvidenceController } from '../clusters/maintenance-evidence.controller.js';
import { MaintenanceInitializeController } from '../clusters/maintenance-initialize.controller.js';
import { MaintenanceEvidenceRecovery } from '../clusters/maintenance-evidence-recovery.js';
import { ClusterMaintenanceRepository } from '../clusters/cluster-maintenance.repository.js';
import { MaintenanceControlLease } from '../clusters/maintenance-control-lease.js';
import { DbModule } from '../db/db.module.js';
import { registeredAgentClient } from '../clusters/registered-agent-client.js';
import type { AgentClient } from './agent-client.js';

@Module({
  controllers: [MaintenanceCloseController, MaintenanceRecoveryController, MaintenanceEvidenceController, MaintenanceInitializeController],
  imports: [ClusterBindingModule, DbModule],
  providers: [
    {
      provide: MANAGER_AGENT_CONFIG,
      useFactory: loadManagerAgentConfig,
    },
    MaintenanceDispatchJournal,
    MaintenanceControlLease,
    ClusterMaintenanceRepository,
    MaintenanceManagerBarrier,
    MaintenanceEvidenceRecovery,
    { provide: OperationLock, useFactory: (db: Database, policy: ClusterBindingPolicy) => new RegisteredOperationLock(db, policy), inject: [Database, ClusterBindingPolicy] },
    HttpAgentClient,
    { provide: AGENT_CLIENT,
      useFactory: (raw: HttpAgentClient, policy: ClusterBindingPolicy, db: Database): AgentClient => registeredAgentClient(raw, policy, db),
      inject: [HttpAgentClient, ClusterBindingPolicy, Database],
    },
  ],
  exports: [AGENT_CLIENT, MANAGER_AGENT_CONFIG, HttpAgentClient, MaintenanceManagerBarrier],
})
export class AgentModule {}
