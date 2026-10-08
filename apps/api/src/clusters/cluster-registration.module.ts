import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DbModule } from '../db/db.module.js';
import { ClusterRegistrationController } from './cluster-registration.controller.js';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import { ClusterRegistrationService } from './cluster-registration.service.js';

@Module({
  imports: [AgentModule, DbModule],
  controllers: [ClusterRegistrationController],
  providers: [ClusterRegistrationRepository, ClusterRegistrationService],
})
export class ClusterRegistrationModule {}
