import { Injectable } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';

export interface DomainAuditEvent {
  eventId: string;
  actorId: string;
  clusterId: string;
  resourceType: 'application' | 'deployment_target' | 'release';
  resourceId: string;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

@Injectable()
export class AuditRepository {
  async record(
    connection: PoolConnection,
    input: DomainAuditEvent,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO audit_events
       (
         operation_id, actor_id, cluster_id, service_id,
         resource_type, resource_id, action, before_json, after_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.eventId,
        input.actorId,
        input.clusterId,
        input.resourceId,
        input.resourceType,
        input.resourceId,
        input.action,
        input.beforeJson === undefined ? null : JSON.stringify(input.beforeJson),
        input.afterJson === undefined ? null : JSON.stringify(input.afterJson),
      ],
    );
  }
}
