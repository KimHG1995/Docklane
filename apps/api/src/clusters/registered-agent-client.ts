import type { AgentClient } from '../agent/agent-client.js';
import type { ClusterBindingPolicy } from './cluster-binding.policy.js';

// Protect every current and future Agent method, except the liveness check.
// Only the registration service gets the raw HttpAgentClient for initial binding.
export function registeredAgentClient(raw: AgentClient, policy: ClusterBindingPolicy): AgentClient {
  return new Proxy(raw, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'health') return value.bind(target);
      return async (...args: unknown[]) => {
        await policy.assertRegistered();
        return value.apply(target, args);
      };
    },
  });
}
