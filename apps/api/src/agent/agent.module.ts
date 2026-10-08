import { Module } from '@nestjs/common';
import { AGENT_CLIENT } from './agent-client.js';
import {
  MANAGER_AGENT_CONFIG,
  loadManagerAgentConfig,
} from './agent-config.js';
import { HttpAgentClient } from './http-agent.client.js';
import { ClusterBindingModule } from '../clusters/cluster-binding.module.js';
import { ClusterBindingPolicy } from '../clusters/cluster-binding.policy.js';
import { registeredAgentClient } from '../clusters/registered-agent-client.js';
import type { AgentClient } from './agent-client.js';

@Module({
  imports: [ClusterBindingModule],
  providers: [
    {
      provide: MANAGER_AGENT_CONFIG,
      useFactory: loadManagerAgentConfig,
    },
    HttpAgentClient,
    { provide: AGENT_CLIENT,
      useFactory: (raw: HttpAgentClient, policy: ClusterBindingPolicy): AgentClient => registeredAgentClient(raw, policy),
      inject: [HttpAgentClient, ClusterBindingPolicy],
    },
  ],
  exports: [AGENT_CLIENT, MANAGER_AGENT_CONFIG, HttpAgentClient],
})
export class AgentModule {}
