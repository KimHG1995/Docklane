import type {
  CapacityCheckRequest,
  CapacityCheckResponse,
} from './capacity-model.js';
import type {
  AgentIdentityResponse,
  ClusterResponse,
  HealthResponse,
  NodeDetailResponse,
  NodeLabelMutationPlan,
  NodeMutationPlan,
  NodeMutationResponse,
  ServiceDetailResponse,
  ServiceImageMutationPlan,
  ServiceMutationPlan,
  ServiceMutationResponse,
  ServiceSummary,
  TaskSummary,
} from './read-model.js';

export interface AgentClient {
  health(): Promise<HealthResponse>;
  identity(): Promise<AgentIdentityResponse>;
  inspectCluster(): Promise<ClusterResponse>;
  listServices(): Promise<ServiceSummary[]>;
  inspectService(serviceId: string): Promise<ServiceDetailResponse>;
  listServiceTasks(serviceId: string): Promise<TaskSummary[]>;
  checkServicePlacement(serviceId: string): Promise<import('./placement-model.js').ServicePlacementResponse>;
  checkServiceCapacity(
    serviceId: string,
    input: CapacityCheckRequest,
  ): Promise<CapacityCheckResponse>;
  inspectNode(nodeId: string): Promise<NodeDetailResponse>;
  planDrainNode(nodeId: string, expectedVersion: number): Promise<NodeMutationPlan>;
  drainNode(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      expectedServiceIds?: string[];
    },
  ): Promise<NodeMutationResponse>;
  planActivateNode(nodeId: string, expectedVersion: number): Promise<NodeMutationPlan>;
  activateNode(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<NodeMutationResponse>;

  planNodeLabels(
    nodeId: string,
    input: {
      expectedVersion: number;
      set: Record<string, string>;
      remove: string[];
    },
  ): Promise<NodeLabelMutationPlan>;

  updateNodeLabels(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      expectedServiceIds: string[];
      targetLabels: Record<string, string>;
    },
  ): Promise<NodeMutationResponse>;


  planScaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationPlan>;

  planRestartService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceMutationPlan>;

  planUpdateServiceImage(
    serviceId: string,
    expectedVersion: number,
    image: string,
  ): Promise<ServiceImageMutationPlan>;

  planRollbackService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceImageMutationPlan>;

  scaleService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      replicas: number;
    },
  ): Promise<ServiceMutationResponse>;

  restartService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<ServiceMutationResponse>;

  updateServiceImage(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      image: string;
    },
  ): Promise<ServiceMutationResponse>;

  rollbackService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<ServiceMutationResponse>;
}

export const AGENT_CLIENT = Symbol('AGENT_CLIENT');

export class AgentRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
  ) {
    super(`Agent request failed with ${statusCode}`);
  }
}

// Only use for the response to the mutation request itself, never to infer the
// outcome of an earlier request from a later read or from an unchanged spec.
export function isDeterministicAgentRejection(
  error: unknown,
): error is AgentRequestError {
  if (!(error instanceof AgentRequestError)) return false;
  // Preserve the existing validation/version-conflict rejection contract.
  if (error.statusCode === 400 || error.statusCode === 409) return true;
  if (![412, 428, 503].includes(error.statusCode)) return false;
  if (typeof error.responseBody !== 'string') return false;

  let body: unknown;
  try {
    body = JSON.parse(error.responseBody);
  } catch {
    return false;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('code' in body)) {
    return false;
  }
  // These exact status/code pairs are emitted by the Agent admission guard
  // before DockerReader mutation dispatch. A generic 503 is still uncertain.
  return (
    (error.statusCode === 412 && body.code === 'CLUSTER_PRECONDITION_FAILED') ||
    (error.statusCode === 428 && body.code === 'CLUSTER_PRECONDITION_REQUIRED') ||
    (error.statusCode === 503 && body.code === 'CLUSTER_IDENTITY_UNAVAILABLE')
  );
}
