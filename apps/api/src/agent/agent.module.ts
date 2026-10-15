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
import { MaintenanceDispatchJournal } from '../clusters/maintenance-dispatch-journal.js';
import { MaintenanceManagerBarrier } from '../clusters/maintenance-manager-barrier.js';
import { MaintenanceCloseController } from '../clusters/maintenance-close.controller.js';
import { ClusterMaintenanceRepository } from '../clusters/cluster-maintenance.repository.js';
import { DbModule } from '../db/db.module.js';
import { registeredAgentClient } from '../clusters/registered-agent-client.js';
import type { AgentClient } from './agent-client.js';

@Module({
  controllers: [MaintenanceCloseController],
  imports: [ClusterBindingModule, DbModule],
  providers: [
    {
      provide: MANAGER_AGENT_CONFIG,
      useFactory: loadManagerAgentConfig,
    },
    MaintenanceDispatchJournal,
    ClusterMaintenanceRepository,
    MaintenanceManagerBarrier,
    HttpAgentClient,
    { provide: AGENT_CLIENT,
      useFactory: (raw: HttpAgentClient, policy: ClusterBindingPolicy, db: Database): AgentClient => registeredAgentClient(raw, policy, db),
      inject: [HttpAgentClient, ClusterBindingPolicy, Database],
    },
  ],
  exports: [AGENT_CLIENT, MANAGER_AGENT_CONFIG, HttpAgentClient, MaintenanceManagerBarrier],
})
export class AgentModule {}
