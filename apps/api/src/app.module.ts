import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [AgentModule],
  controllers: [HealthController],
})
export class AppModule {}
