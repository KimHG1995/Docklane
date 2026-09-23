import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { CapacityController } from './capacity.controller.js';
import { CapacityService } from './capacity.service.js';

@Module({
  imports: [AgentModule],
  controllers: [CapacityController],
  providers: [CapacityService],
  exports: [CapacityService],
})
export class CapacityModule {}
