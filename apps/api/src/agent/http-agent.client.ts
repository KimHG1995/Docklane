import { Injectable } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { z } from 'zod';
import type { AgentClient } from './agent-client.js';
import { loadAgentConfig, type AgentConfig } from './agent-config.js';
import {
  ClusterResponseSchema,
  HealthResponseSchema,
  ServiceDetailResponseSchema,
  ServiceSummarySchema,
  TaskSummarySchema,
  type ClusterResponse,
  type HealthResponse,
  type ServiceDetailResponse,
  type ServiceSummary,
  type TaskSummary,
} from './read-model.js';

@Injectable()
export class HttpAgentClient implements AgentClient {
  private readonly config: AgentConfig = loadAgentConfig();

  health(): Promise<HealthResponse> {
    return this.get('/v1/health', HealthResponseSchema);
  }

  inspectCluster(): Promise<ClusterResponse> {
    return this.get('/v1/cluster', ClusterResponseSchema);
  }

  listServices(): Promise<ServiceSummary[]> {
    return this.get('/v1/services', z.array(ServiceSummarySchema));
  }

  inspectService(serviceId: string): Promise<ServiceDetailResponse> {
    return this.get(
      `/v1/services/${encodeURIComponent(serviceId)}`,
      ServiceDetailResponseSchema,
    );
  }

  listServiceTasks(serviceId: string): Promise<TaskSummary[]> {
    return this.get(
      `/v1/services/${encodeURIComponent(serviceId)}/tasks`,
      z.array(TaskSummarySchema),
    );
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    const options: RequestOptions = {
      method: 'GET',
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
            reject(new Error(`Agent request failed with ${res.statusCode}: ${body}`));
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
      req.end();
    });
  }
}
