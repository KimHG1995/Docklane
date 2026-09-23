import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { CapacityModule } from '../capacity/capacity.module.js';
import { DbModule } from '../db/db.module.js';
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import { MutationController } from './mutation.controller.js';
import { NodeMutationController } from './node-mutation.controller.js';
import { MutationService } from './mutation.service.js';
import { NodeMutationService } from './node-mutation.service.js';
import { NodeOperationRepository } from './node-operation.repository.js';

@Module({
  imports: [DbModule, AgentModule, CapacityModule],
  controllers: [MutationController, NodeMutationController],
  providers: [
    OperationRepository,
    NodeOperationRepository,
    OperationLock,
    MutationService,
    NodeMutationService,
  ],
})
export class OperationsModule {}
