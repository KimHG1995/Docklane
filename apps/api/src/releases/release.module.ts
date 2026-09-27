import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DbModule } from '../db/db.module.js';
import { ReleaseController } from './release.controller.js';
import { ReleaseRepository } from './release.repository.js';
import { ReleaseService } from './release.service.js';

@Module({
  imports: [DbModule, AgentModule],
  controllers: [ReleaseController],
  providers: [ReleaseRepository, ReleaseService],
})
export class ReleaseModule {}
