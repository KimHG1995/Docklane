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
  ServiceMutationPlanSchema,
  ServiceMutationResponseSchema,
  ServiceSummarySchema,
  TaskSummarySchema,
  type ClusterResponse,
  type HealthResponse,
  type ServiceDetailResponse,
  type ServiceMutationPlan,
  type ServiceMutationResponse,
  type ServiceSummary,
  type TaskSummary,
} from './read-model.js';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

  planScaleService(
    serviceId: string,
    expectedVersion: number,
    replicas: number,
  ): Promise<ServiceMutationPlan> {
    return this.request(
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
    return this.request(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/plan-restart`,
      ServiceMutationPlanSchema,
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
    return this.request(
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
    return this.request(
      'POST',
      `/v1/services/${encodeURIComponent(serviceId)}/restart`,
      ServiceMutationResponseSchema,
      input,
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
          rejectOnce(new Error('Agent response aborted'));
        });
        res.once('error', (error) => {
          rejectOnce(
            error instanceof Error
              ? error
              : new Error(`Agent response error: ${String(error)}`),
          );
        });
        res.once('close', () => {
          if (!ended) {
            rejectOnce(new Error('Agent response closed before completion'));
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
        req.destroy(new Error('Agent request timed out')),
      );
      req.on('error', (error) => rejectOnce(error));

      if (body !== undefined) {
        req.setHeader('Content-Type', 'application/json');
        req.end(JSON.stringify(body));
      } else {
        req.end();
      }
    });
  }
}
