export type AgentJson = Record<string, unknown>;

export interface AgentClient {
  health(): Promise<AgentJson>;
  inspectCluster(): Promise<AgentJson>;
  inspectService(serviceId: string): Promise<AgentJson>;
  listServiceTasks(serviceId: string): Promise<AgentJson>;
}

export const AGENT_CLIENT = Symbol('AGENT_CLIENT');
