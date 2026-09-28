import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import { Database } from '../db/database.js';

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
export class AuditRepository implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        operation_id VARCHAR(64) NOT NULL,
        actor_id VARCHAR(128) NOT NULL,
        cluster_id VARCHAR(128) NOT NULL,
        service_id VARCHAR(128) NOT NULL,
        resource_type VARCHAR(32) NOT NULL DEFAULT 'service',
        resource_id VARCHAR(128) NOT NULL DEFAULT '',
        action VARCHAR(64) NOT NULL,
        before_json JSON NULL,
        after_json JSON NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_audit_operation (operation_id),
        INDEX idx_audit_resource (cluster_id, service_id, created_at)
      ) ENGINE=InnoDB
    `);
  }

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
