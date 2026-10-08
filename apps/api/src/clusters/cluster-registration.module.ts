import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { ClusterBindingModule } from './cluster-binding.module.js';
import { ClusterRegistrationController } from './cluster-registration.controller.js';
import { ClusterRegistrationService } from './cluster-registration.service.js';

@Module({
  imports: [AgentModule, ClusterBindingModule],
  controllers: [ClusterRegistrationController],
  providers: [ClusterRegistrationService],
})
export class ClusterRegistrationModule {}
