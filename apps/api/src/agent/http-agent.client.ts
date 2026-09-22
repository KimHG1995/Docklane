import { Injectable } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { z } from 'zod';
import { AgentRequestError, type AgentClient } from './agent-client.js';
import { loadAgentConfig, type AgentConfig } from './agent-config.js';
import {
  ClusterResponseSchema,
  HealthResponseSchema,
  ServiceDetailResponseSchema,
  ServiceSummarySchema,
  ServiceMutationResponseSchema,
  TaskSummarySchema,
  type ClusterResponse,
  type HealthResponse,
  type ServiceDetailResponse,
  type ServiceSummary,
  type ServiceMutationResponse,
  type TaskSummary,
} from './read-model.js';

@Injectable()
export class HttpAgentClient implements AgentClient {
  private readonly config: AgentConfig = loadAgentConfig();

  health(): Promise<HealthResponse> {
    return this.request('GET', '/v1/health', HealthResponseSchema);
  }

  inspectCluster(): Promise<ClusterResponse> {
    return this.request('GET', '/v1/cluster', ClusterResponseSchema);
  }

  listServices(): Promise<ServiceSummary[]> {
    return this.request('GET', '/v1/services', z.array(ServiceSummarySchema));
  }

  inspectService(serviceId: string): Promise<ServiceDetailResponse> {
    return this.request(
      'GET',
      `/v1/services/${encodeURIComponent(serviceId)}`,
      ServiceDetailResponseSchema,
    );
  }

  listServiceTasks(serviceId: string): Promise<TaskSummary[]> {
    return this.request(
      'GET',
      `/v1/services/${encodeURIComponent(serviceId)}/tasks`,
      z.array(TaskSummarySchema),
    );
  }

  scaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationResponse> {
    return this.request(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/scale`,
      ServiceMutationResponseSchema,
      { expectedVersion, replicas },
    );
  }

  restartService(
    serviceId: string,
    expectedVersion: number,
  ): Promise<ServiceMutationResponse> {
    return this.request(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/restart`,
      ServiceMutationResponseSchema,
      { expectedVersion },
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    const options: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      ca: this.config.ca,
      cert: this.config.cert,
      key: this.config.key,
      rejectUnauthorized: !this.config.insecureDev,
      timeout: 5_000,
    };

    return new Promise<T>((resolve, reject) => {
      const onResponse = (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new AgentRequestError(res.statusCode ?? 500, body));
            return;
          }

          try {
            resolve(schema.parse(JSON.parse(body)));
          } catch (error) {
            reject(
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

      req.on('timeout', () => req.destroy(new Error('Agent request timed out')));
      req.on('error', reject);
      if (body !== undefined) {
        req.setHeader('Content-Type', 'application/json');
        req.end(JSON.stringify(body));
      } else {
        req.end();
      }
    });
  }
}
