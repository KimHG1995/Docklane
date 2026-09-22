import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DbModule } from '../db/db.module.js';
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import { MutationController } from './mutation.controller.js';
import { MutationService } from './mutation.service.js';

@Module({
  imports: [DbModule, AgentModule],
  controllers: [MutationController],
  providers: [OperationRepository, OperationLock, MutationService],
})
export class OperationsModule {}
