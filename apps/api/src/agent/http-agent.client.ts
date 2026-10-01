import { Inject, Injectable } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { z } from 'zod';
import { AgentRequestError, type AgentClient } from './agent-client.js';
import {
  MANAGER_AGENT_CONFIG,
  loadManagerAgentConfig,
  type AgentConfig,
  type ManagerAgentConfig,
} from './agent-config.js';
import {
  CapacityCheckResponseSchema,
} from './capacity-model.js';
import {
  ServicePlacementResponseSchema,
  type ServicePlacementResponse,
} from './placement-model.js';
import type {
  CapacityCheckRequest,
  CapacityCheckResponse,
} from './capacity-model.js';
import {
  AgentIdentityResponseSchema,
  ClusterResponseSchema,
  HealthResponseSchema,
  NodeDetailResponseSchema,
  NodeLabelMutationPlanSchema,
  NodeMutationPlanSchema,
  NodeMutationResponseSchema,
  ServiceDetailResponseSchema,
  ServiceImageMutationPlanSchema,
  ServiceMutationPlanSchema,
  ServiceMutationResponseSchema,
  ServiceSummarySchema,
  TaskSummarySchema,
  type AgentIdentityResponse,
  type ClusterResponse,
  type HealthResponse,
  type NodeDetailResponse,
  type NodeLabelMutationPlan,
  type NodeMutationPlan,
  type NodeMutationResponse,
  type ServiceDetailResponse,
  type ServiceImageMutationPlan,
  type ServiceMutationPlan,
  type ServiceMutationResponse,
  type ServiceSummary,
  type TaskSummary,
} from './read-model.js';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const AGENT_FAILURE_COOLDOWN_MS = 5_000;

class AgentTransportError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Agent ${agentId} transport failed: ${message}`, { cause });
  }
}

class AgentIdentityError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Agent ${agentId} identity validation failed: ${message}`, { cause });
  }
}

@Injectable()
export class HttpAgentClient implements AgentClient {
  private readonly registry: ManagerAgentConfig;
  private activeId: string;
  private referenceClusterId: string | null = null;
  private readonly verifiedClusters = new Map<string, string>();
  private readonly unavailableUntil = new Map<string, number>();

  constructor(
    @Inject(MANAGER_AGENT_CONFIG)
    registry: ManagerAgentConfig = loadManagerAgentConfig(),
  ) {
    const primary = registry.agents.find(
      (agent) => agent.id === registry.primaryId,
    );
    if (!primary) {
      throw new Error('Primary manager Agent configuration disappeared');
    }
    this.registry = registry;
    this.activeId = primary.id;
  }

  health(): Promise<HealthResponse> {
    return this.healthWithFailover();
  }

  identity(): Promise<AgentIdentityResponse> {
    return this.identityWithFailover();
  }

  inspectCluster(): Promise<ClusterResponse> {
    return this.safeRequest('GET', '/v1/cluster', ClusterResponseSchema);
  }

  listServices(): Promise<ServiceSummary[]> {
    return this.safeRequest('GET', '/v1/services', z.array(ServiceSummarySchema));
  }

  inspectService(serviceId: string): Promise<ServiceDetailResponse> {
    return this.safeRequest(
      'GET',
      `/v1/services/${encodeURIComponent(serviceId)}`,
      ServiceDetailResponseSchema,
    );
  }

  listServiceTasks(serviceId: string): Promise<TaskSummary[]> {
    return this.safeRequest(
      'GET',
      `/v1/services/${encodeURIComponent(serviceId)}/tasks`,
      z.array(TaskSummarySchema),
    );
  }

  checkServicePlacement(serviceId: string): Promise<ServicePlacementResponse> {
    return this.safeRequest(
      'GET',
      `/v1/services/${encodeURIComponent(serviceId)}/placement-check`,
      ServicePlacementResponseSchema,
    );
  }

  checkServiceCapacity(
    serviceId: string,
    input: CapacityCheckRequest,
  ): Promise<CapacityCheckResponse> {
    return this.safeRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/capacity-check`,
      CapacityCheckResponseSchema,
      input,
    );
  }


  inspectNode(nodeId: string): Promise<NodeDetailResponse> {
    return this.safeRequest(
      'GET',
      `/v1/nodes/${encodeURIComponent(nodeId)}`,
      NodeDetailResponseSchema,
    );
  }

  planDrainNode(
    nodeId: string,
    expectedVersion: number,
  ): Promise<NodeMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/plan-drain`,
      NodeMutationPlanSchema,
      { expectedVersion },
    );
  }

  drainNode(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      expectedServiceIds?: string[];
    },
  ): Promise<NodeMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/drain`,
      NodeMutationResponseSchema,
      input,
    );
  }

  planActivateNode(
    nodeId: string,
    expectedVersion: number,
  ): Promise<NodeMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/plan-activate`,
      NodeMutationPlanSchema,
      { expectedVersion },
    );
  }

  activateNode(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      expectedServiceIds?: string[];
    },
  ): Promise<NodeMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/activate`,
      NodeMutationResponseSchema,
      input,
    );
  }

  planNodeLabels(
    nodeId: string,
    input: {
      expectedVersion: number;
      set: Record<string, string>;
      remove: string[];
    },
  ): Promise<NodeLabelMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/plan-labels`,
      NodeLabelMutationPlanSchema,
      input,
    );
  }

  updateNodeLabels(
    nodeId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      expectedServiceIds: string[];
      targetLabels: Record<string, string>;
    },
  ): Promise<NodeMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/nodes/${encodeURIComponent(nodeId)}/labels`,
      NodeMutationResponseSchema,
      input,
    );
  }

  planScaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/plan-scale`,
      ServiceMutationPlanSchema,
      { expectedVersion, replicas },
    );
  }

  planRestartService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/plan-restart`,
      ServiceMutationPlanSchema,
      { expectedVersion },
    );
  }

  planUpdateServiceImage(
    serviceId: string,
    expectedVersion: number,
    image: string,
  ): Promise<ServiceImageMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/plan-image-update`,
      ServiceImageMutationPlanSchema,
      { expectedVersion, image },
    );
  }

  planRollbackService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceImageMutationPlan> {
    return this.safeRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/plan-rollback`,
      ServiceImageMutationPlanSchema,
      { expectedVersion },
    );
  }

  scaleService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      replicas: number;
    },
  ): Promise<ServiceMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/scale`,
      ServiceMutationResponseSchema,
      input,
    );
  }

  restartService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<ServiceMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/restart`,
      ServiceMutationResponseSchema,
      input,
    );
  }

  updateServiceImage(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
      image: string;
    },
  ): Promise<ServiceMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/image`,
      ServiceMutationResponseSchema,
      input,
    );
  }

  rollbackService(
    serviceId: string,
    input: {
      expectedVersion: number;
      expectedSpecHash: string;
      targetSpecHash: string;
    },
  ): Promise<ServiceMutationResponse> {
    return this.mutationRequest(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/rollback`,
      ServiceMutationResponseSchema,
      input,
    );
  }

  private async healthWithFailover(): Promise<HealthResponse> {
    let lastError: unknown = new Error('No manager Agent is available');

    for (const config of this.candidateAgents()) {
      try {
        const value = await this.requestTo(
          config,
          'GET',
          '/v1/health',
          HealthResponseSchema,
        );
        this.markActive(config);
        return value;
      } catch (error) {
        if (!isRetryableAgentFailure(error)) {
          throw error;
        }
        lastError = error;
        this.markUnavailable(config);
      }
    }

    throw normalizeError(lastError);
  }

  private async safeRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let lastError: unknown = new Error('No manager Agent is available');

    for (const config of this.candidateAgents()) {
      try {
        await this.verifyAgent(config);
        const value = await this.requestTo(config, method, path, schema, body);
        this.markActive(config);
        return value;
      } catch (error) {
        if (!shouldFailover(error)) {
          throw error;
        }
        lastError = error;
        this.markUnavailable(config);
      }
    }

    throw normalizeError(lastError);
  }

  private async mutationRequest<T>(
    method: 'POST',
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
  ): Promise<T> {
    const config = await this.selectMutationAgent();

    try {
      const value = await this.requestTo(config, method, path, schema, body);
      this.markActive(config);
      return value;
    } catch (error) {
      if (isRetryableAgentFailure(error)) {
        this.markUnavailable(config);
      }
      throw error;
    }
  }

  private async identityWithFailover(): Promise<AgentIdentityResponse> {
    let lastError: unknown = new Error('No manager Agent is available');

    for (const config of this.candidateAgents()) {
      try {
        const identity = await this.readIdentity(config);
        this.markActive(config);
        return identity;
      } catch (error) {
        if (!shouldFailover(error)) {
          throw error;
        }
        lastError = error;
        this.markUnavailable(config);
      }
    }

    throw normalizeError(lastError);
  }

  private async selectMutationAgent(): Promise<AgentConfig> {
    let lastError: unknown = new Error('No manager Agent is available');

    for (const config of this.candidateAgents()) {
      try {
        await this.verifyAgent(config);
        this.markActive(config);
        return config;
      } catch (error) {
        if (!shouldFailover(error)) {
          throw error;
        }
        lastError = error;
        this.markUnavailable(config);
      }
    }

    throw normalizeError(lastError);
  }

  private candidateAgents(): AgentConfig[] {
    const ordered = [
      ...this.registry.agents.filter((agent) => agent.id === this.activeId),
      ...this.registry.agents.filter((agent) => agent.id !== this.activeId),
    ];
    const now = Date.now();
    const available = ordered.filter(
      (agent) => (this.unavailableUntil.get(agent.id) ?? 0) <= now,
    );
    return available.length > 0 ? available : ordered;
  }

  private async verifyAgent(config: AgentConfig): Promise<void> {
    const cachedClusterId = this.verifiedClusters.get(config.id);
    if (
      cachedClusterId &&
      (this.referenceClusterId === null ||
        cachedClusterId === this.referenceClusterId)
    ) {
      return;
    }
    await this.readIdentity(config);
  }

  private async readIdentity(
    config: AgentConfig,
  ): Promise<AgentIdentityResponse> {
    let identity: AgentIdentityResponse;
    try {
      identity = await this.requestTo(
        config,
        'GET',
        '/v1/identity',
        AgentIdentityResponseSchema,
      );
    } catch (error) {
      if (isRetryableAgentFailure(error)) {
        throw error;
      }
      throw new AgentIdentityError(
        config.id,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    const referenceClusterId = this.referenceClusterId;
    if (
      referenceClusterId !== null &&
      identity.clusterId !== referenceClusterId
    ) {
      throw new AgentIdentityError(
        config.id,
        `cluster ${identity.clusterId} does not match ${referenceClusterId}`,
      );
    }

    if (this.referenceClusterId === null) {
      this.referenceClusterId = identity.clusterId;
    }
    this.verifiedClusters.set(config.id, identity.clusterId);
    return identity;
  }

  private markActive(config: AgentConfig): void {
    this.activeId = config.id;
    this.unavailableUntil.delete(config.id);
  }

  private markUnavailable(config: AgentConfig): void {
    this.unavailableUntil.set(
      config.id,
      Date.now() + AGENT_FAILURE_COOLDOWN_MS,
    );
    this.verifiedClusters.delete(config.id);
  }

  private async requestTo<T>(
    config: AgentConfig,
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, config.baseUrl);
    const options: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      ca: config.ca,
      cert: config.cert,
      key: config.key,
      rejectUnauthorized: !config.insecureDev,
      timeout: REQUEST_TIMEOUT_MS,
    };

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const resolveOnce = (value: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const onResponse = (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let ended = false;

        res.setTimeout(REQUEST_TIMEOUT_MS, () => {
          res.destroy(new Error('Agent response timed out'));
        });

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy(new Error('Agent response exceeded size limit'));
            return;
          }
          chunks.push(chunk);
        });

        res.once('aborted', () => {
          rejectOnce(
            new AgentTransportError(config.id, 'response aborted'),
          );
        });
        res.once('error', (error) => {
          rejectOnce(
            toTransportError(config.id, 'response error', error),
          );
        });
        res.once('close', () => {
          if (!ended) {
            rejectOnce(
              new AgentTransportError(
                config.id,
                'response closed before completion',
              ),
            );
          }
        });
        res.once('end', () => {
          ended = true;
          const responseBody = Buffer.concat(chunks).toString('utf8');

          if ((res.statusCode ?? 500) >= 400) {
            rejectOnce(
              new AgentRequestError(res.statusCode ?? 500, responseBody),
            );
            return;
          }

          try {
            resolveOnce(schema.parse(JSON.parse(responseBody)));
          } catch (error) {
            rejectOnce(
              new Error(
                `Agent response failed contract validation: ${String(error)}`,
              ),
            );
          }
        });
      };

      const req =
        url.protocol === 'https:'
          ? httpsRequest(options, onResponse)
          : httpRequest(options, onResponse);

      req.on('timeout', () =>
        req.destroy(
          new AgentTransportError(config.id, 'request timed out'),
        ),
      );
      req.on('error', (error) =>
        rejectOnce(toTransportError(config.id, 'request error', error)),
      );

      if (body !== undefined) {
        req.setHeader('Content-Type', 'application/json');
        req.end(JSON.stringify(body));
      } else {
        req.end();
      }
    });
  }
}


function isRetryableAgentFailure(error: unknown): boolean {
  return (
    error instanceof AgentTransportError ||
    (error instanceof AgentRequestError && error.statusCode >= 500)
  );
}

function shouldFailover(error: unknown): boolean {
  return (
    isRetryableAgentFailure(error) ||
    error instanceof AgentIdentityError
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toTransportError(
  agentId: string,
  message: string,
  error: unknown,
): AgentTransportError {
  return error instanceof AgentTransportError
    ? error
    : new AgentTransportError(agentId, message, error);
}
