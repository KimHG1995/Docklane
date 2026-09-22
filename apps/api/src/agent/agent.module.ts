import { Module } from '@nestjs/common';
import { AGENT_CLIENT } from './agent-client.js';
import { HttpAgentClient } from './http-agent.client.js';

@Module({
  providers: [
    HttpAgentClient,
    { provide: AGENT_CLIENT, useExisting: HttpAgentClient },
  ],
  exports: [AGENT_CLIENT],
})
export class AgentModule {}
