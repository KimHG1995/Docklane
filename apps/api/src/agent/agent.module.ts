import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.js';
import { AGENT_CLIENT } from './agent-client.js';
import { HttpAgentClient } from './http-agent.client.js';

@Module({
  controllers: [AgentController],
  providers: [
    HttpAgentClient,
    { provide: AGENT_CLIENT, useExisting: HttpAgentClient },
  ],
  exports: [AGENT_CLIENT],
})
export class AgentModule {}
