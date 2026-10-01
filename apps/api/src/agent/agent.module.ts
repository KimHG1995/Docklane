import { Module } from '@nestjs/common';
import { AGENT_CLIENT } from './agent-client.js';
import {
  MANAGER_AGENT_CONFIG,
  loadManagerAgentConfig,
} from './agent-config.js';
import { HttpAgentClient } from './http-agent.client.js';

@Module({
  providers: [
    {
      provide: MANAGER_AGENT_CONFIG,
      useFactory: loadManagerAgentConfig,
    },
    HttpAgentClient,
    { provide: AGENT_CLIENT, useExisting: HttpAgentClient },
  ],
  exports: [AGENT_CLIENT, MANAGER_AGENT_CONFIG],
})
export class AgentModule {}
