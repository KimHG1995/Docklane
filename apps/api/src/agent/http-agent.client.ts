import { Injectable } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { AgentClient, AgentJson } from './agent-client.js';
import { loadAgentConfig, type AgentConfig } from './agent-config.js';

@Injectable()
export class HttpAgentClient implements AgentClient {
  private readonly config: AgentConfig = loadAgentConfig();

  health(): Promise<AgentJson> {
    return this.get('/v1/health');
  }

  inspectCluster(): Promise<AgentJson> {
    return this.get('/v1/cluster');
  }

  inspectService(serviceId: string): Promise<AgentJson> {
    return this.get(`/v1/services/${encodeURIComponent(serviceId)}`);
  }

  listServiceTasks(serviceId: string): Promise<AgentJson> {
    return this.get(`/v1/services/${encodeURIComponent(serviceId)}/tasks`);
  }

  private async get(path: string): Promise<AgentJson> {
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

    return new Promise<AgentJson>((resolve, reject) => {
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
            resolve(JSON.parse(body) as AgentJson);
          } catch (error) {
            reject(new Error(`Agent returned invalid JSON: ${String(error)}`));
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
      req.on('error', reject);
      req.end();
    });
  }
}
