import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { CapacityModule } from '../capacity/capacity.module.js';
import { DbModule } from '../db/db.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { ReleaseModule } from '../releases/release.module.js';
import { DeploymentController } from './deployment.controller.js';
import { DeploymentRepository } from './deployment.repository.js';
import { DeploymentService } from './deployment.service.js';
import { HealthEndpointPolicy } from './health-endpoint.policy.js';
import { HealthVerifier } from './health-verifier.js';

@Module({
  imports: [
    DbModule,
    AgentModule,
    CapacityModule,
    OperationsModule,
    ReleaseModule,
  ],
  controllers: [DeploymentController],
  providers: [
    DeploymentRepository,
    DeploymentService,
    HealthEndpointPolicy,
    HealthVerifier,
  ],
})
export class DeploymentModule {}
