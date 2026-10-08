import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DbModule } from '../db/db.module.js';
import { ClusterBindingModule } from '../clusters/cluster-binding.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { BootstrapRepository } from './bootstrap.repository.js';
import { BootstrapService } from './bootstrap.service.js';
import { SwarmJoinCredentialProvider } from './swarm-join-credential.provider.js';

@Module({
  imports: [DbModule, AgentModule, OperationsModule, ClusterBindingModule],
  controllers: [BootstrapController],
  providers: [
    BootstrapRepository,
    BootstrapService,
    SwarmJoinCredentialProvider,
  ],
  exports: [BootstrapService],
})
export class BootstrapModule {}
