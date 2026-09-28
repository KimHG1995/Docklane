import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DeploymentModule } from './deployments/deployment.module.js';
import { HealthController } from './health.controller.js';
import { ReadModule } from './read/read.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { ReleaseModule } from './releases/release.module.js';

@Module({
  imports: [
    AuthModule,
    AgentModule,
    ReadModule,
    OperationsModule,
    ReleaseModule,
    DeploymentModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
