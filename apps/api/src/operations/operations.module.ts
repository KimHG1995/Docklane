import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { CapacityModule } from '../capacity/capacity.module.js';
import { DbModule } from '../db/db.module.js';
import { Database } from '../db/database.js';
import { ClusterBindingModule } from '../clusters/cluster-binding.module.js';
import { ClusterBindingPolicy } from '../clusters/cluster-binding.policy.js';
import { RegisteredOperationLock } from '../clusters/registered-operation-lock.js';
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import { MutationController } from './mutation.controller.js';
import { NodeMutationController } from './node-mutation.controller.js';
import { MutationService } from './mutation.service.js';
import { NodeMutationService } from './node-mutation.service.js';
import { NodeOperationRepository } from './node-operation.repository.js';

@Module({
  imports: [DbModule, AgentModule, CapacityModule, ClusterBindingModule],
  controllers: [MutationController, NodeMutationController],
  providers: [
    OperationRepository,
    NodeOperationRepository,
    { provide: OperationLock, useFactory: (db: Database, policy: ClusterBindingPolicy) => new RegisteredOperationLock(db, policy), inject: [Database, ClusterBindingPolicy] },
    MutationService,
    NodeMutationService,
  ],
  exports: [
    OperationRepository,
    NodeOperationRepository,
    OperationLock,
    NodeMutationService,
  ],
})
export class OperationsModule {}
