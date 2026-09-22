import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { ReadController } from './read.controller.js';
import { ReadService } from './read.service.js';

@Module({
  imports: [AgentModule],
  controllers: [ReadController],
  providers: [ReadService],
})
export class ReadModule {}
