import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import type {
  NodeOperationRecord,
  NodeOperationType,
  OperationStatus,
} from './operation.types.js';

interface NodeOperationRow extends RowDataPacket {
  id: string;
  cluster_id: string;
  node_id: string;
  type: NodeOperationType;
  status: OperationStatus;
  actor_id: string;
  expected_version: number;
  before_spec_hash: string;
  target_spec_hash: string;
  target_availability: 'drain' | 'active';
  affected_service_ids: string | string[];
  target_labels: string | Record<string, string> | null;
  label_patch: string | { set: Record<string, string>; remove: string[] } | null;
  result_version: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class NodeOperationRepository implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS node_operations (
        id VARCHAR(64) PRIMARY KEY,
        cluster_id VARCHAR(128) NOT NULL,
        node_id VARCHAR(128) NOT NULL,
        type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL,
        actor_id VARCHAR(128) NOT NULL,
        expected_version BIGINT UNSIGNED NOT NULL,
        before_spec_hash VARCHAR(64) NOT NULL,
        target_spec_hash VARCHAR(64) NOT NULL,
        target_availability VARCHAR(16) NOT NULL,
        affected_service_ids JSON NOT NULL,
        target_labels JSON NULL,
        label_patch JSON NULL,
        result_version BIGINT UNSIGNED NULL,
        error_code VARCHAR(64) NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        INDEX idx_node_operations_node (cluster_id, node_id, created_at),
        INDEX idx_node_operations_status (status, updated_at)
      ) ENGINE=InnoDB
    `);
    await this.ensureColumn('target_labels', 'JSON NULL');
    await this.ensureColumn('label_patch', 'JSON NULL');
  }

  async find(id: string): Promise<NodeOperationRecord | null> {
    const [rows] = await this.db.pool.query<NodeOperationRow[]>(
      'SELECT * FROM node_operations WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapNodeOperation(rows[0]) : null;
  }

  async findWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<NodeOperationRecord | null> {
    const [rows] = await connection.query<NodeOperationRow[]>(
      'SELECT * FROM node_operations WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapNodeOperation(rows[0]) : null;
  }

  async listNonTerminal(): Promise<NodeOperationRecord[]> {
    const [rows] = await this.db.pool.query<NodeOperationRow[]>(
      `SELECT * FROM node_operations
       WHERE status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
       ORDER BY created_at ASC`,
    );
    return rows.map(mapNodeOperation);
  }

  async findNonTerminalForNodeWithConnection(
    connection: PoolConnection,
    clusterId: string,
    nodeId: string,
  ): Promise<NodeOperationRecord | null> {
    const [rows] = await connection.query<NodeOperationRow[]>(
      `SELECT * FROM node_operations
       WHERE cluster_id = ?
         AND node_id = ?
         AND status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
       ORDER BY created_at ASC
       LIMIT 1`,
      [clusterId, nodeId],
    );
    return rows[0] ? mapNodeOperation(rows[0]) : null;
  }

  async findNonTerminalForNode(
    clusterId: string,
    nodeId: string,
  ): Promise<NodeOperationRecord | null> {
    const [rows] = await this.db.pool.query<NodeOperationRow[]>(
      `SELECT * FROM node_operations
       WHERE cluster_id = ?
         AND node_id = ?
         AND status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
       ORDER BY created_at ASC
       LIMIT 1`,
      [clusterId, nodeId],
    );
    return rows[0] ? mapNodeOperation(rows[0]) : null;
  }

  async findNonTerminalAffectingServiceWithConnection(
    connection: PoolConnection,
    clusterId: string,
    serviceId: string,
  ): Promise<NodeOperationRecord | null> {
    const [rows] = await connection.query<NodeOperationRow[]>(
      `SELECT * FROM node_operations
       WHERE cluster_id = ?
         AND status IN ('PENDING', 'RUNNING', 'VERIFYING', 'NEEDS_ATTENTION')
         AND JSON_CONTAINS(
           affected_service_ids,
           JSON_QUOTE(?),
           '$'
         )
       ORDER BY created_at ASC
       LIMIT 1`,
      [clusterId, serviceId],
    );
    return rows[0] ? mapNodeOperation(rows[0]) : null;
  }

  async create(
    connection: PoolConnection,
    input: {
      id: string;
      clusterId: string;
      nodeId: string;
      type: NodeOperationType;
      actorId: string;
      expectedVersion: number;
      beforeSpecHash: string;
      targetSpecHash: string;
      targetAvailability: 'drain' | 'active' | 'pause';
      affectedServiceIds: string[];
      targetLabels?: Record<string, string> | null;
      labelPatch?: { set: Record<string, string>; remove: string[] } | null;
    },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO node_operations
       (
         id, cluster_id, node_id, type, status, actor_id,
         expected_version, before_spec_hash, target_spec_hash,
         target_availability, affected_service_ids, target_labels, label_patch
       )
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.clusterId,
        input.nodeId,
        input.type,
        input.actorId,
        input.expectedVersion,
        input.beforeSpecHash,
        input.targetSpecHash,
        input.targetAvailability,
        JSON.stringify(input.affectedServiceIds),
        input.targetLabels == null ? null : JSON.stringify(input.targetLabels),
        input.labelPatch == null ? null : JSON.stringify(input.labelPatch),
      ],
    );
  }

  private async ensureColumn(
    columnName: string,
    definition: string,
  ): Promise<void> {
    const [rows] = await this.db.pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'node_operations'
         AND column_name = ?`,
      [columnName],
    );
    if ((rows[0]?.count ?? 0) > 0) return;
    if (!/^[a-z_]+$/.test(columnName)) {
      throw new Error('Unsafe node operation column name');
    }
    await this.db.pool.query(
      `ALTER TABLE node_operations ADD COLUMN ${columnName} ${definition}`,
    );
  }

  async markRunning(connection: PoolConnection, id: string): Promise<void> {
    await connection.execute(
      "UPDATE node_operations SET status = 'RUNNING' WHERE id = ?",
      [id],
    );
  }

  async markVerifying(
    connection: PoolConnection,
    id: string,
    resultVersion: number,
  ): Promise<void> {
    await connection.execute(
      `UPDATE node_operations
       SET status = 'VERIFYING', result_version = ?,
           error_code = NULL, error_message = NULL
       WHERE id = ?`,
      [resultVersion, id],
    );
  }

  async markSuccess(
    connection: PoolConnection,
    id: string,
    resultVersion: number,
  ): Promise<void> {
    await connection.execute(
      `UPDATE node_operations
       SET status = 'SUCCESS', result_version = ?,
           error_code = NULL, error_message = NULL
       WHERE id = ?`,
      [resultVersion, id],
    );
  }

  async markFailed(
    connection: PoolConnection,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE node_operations
       SET status = 'FAILED', error_code = ?, error_message = ?
       WHERE id = ?`,
      [code, message, id],
    );
  }

  async markNeedsAttention(
    connection: PoolConnection,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE node_operations
       SET status = 'NEEDS_ATTENTION', error_code = ?, error_message = ?
       WHERE id = ?`,
      [code, message, id],
    );
  }
}

function mapNodeOperation(row: NodeOperationRow): NodeOperationRecord {
  const affected =
    typeof row.affected_service_ids === 'string'
      ? (JSON.parse(row.affected_service_ids) as unknown)
      : row.affected_service_ids;

  const labels =
    row.target_labels == null
      ? null
      : typeof row.target_labels === 'string'
        ? (JSON.parse(row.target_labels) as unknown)
        : row.target_labels;

  const patch =
    row.label_patch == null
      ? null
      : typeof row.label_patch === 'string'
        ? (JSON.parse(row.label_patch) as unknown)
        : row.label_patch;

  return {
    id: row.id,
    clusterId: row.cluster_id,
    nodeId: row.node_id,
    type: row.type,
    status: row.status,
    actorId: row.actor_id,
    expectedVersion: Number(row.expected_version),
    beforeSpecHash: row.before_spec_hash,
    targetSpecHash: row.target_spec_hash,
    targetAvailability: row.target_availability,
    affectedServiceIds: Array.isArray(affected)
      ? affected.filter((value): value is string => typeof value === 'string')
      : [],
    targetLabels:
      labels && typeof labels === 'object' && !Array.isArray(labels)
        ? Object.fromEntries(
            Object.entries(labels).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : null,
    labelPatch:
      patch &&
      typeof patch === 'object' &&
      !Array.isArray(patch) &&
      'set' in patch &&
      'remove' in patch &&
      typeof patch.set === 'object' &&
      patch.set !== null &&
      Array.isArray(patch.remove)
        ? {
            set: Object.fromEntries(
              Object.entries(patch.set).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            ),
            remove: patch.remove.filter(
              (value): value is string => typeof value === 'string',
            ),
          }
        : null,
    resultVersion:
      row.result_version === null ? null : Number(row.result_version),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
