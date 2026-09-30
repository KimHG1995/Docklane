import { Inject, Injectable } from '@nestjs/common';
import type {
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise';
import { Database } from '../db/database.js';
import type {
  BootstrapNodeRole,
  BootstrapTokenRecord,
} from './bootstrap.types.js';

interface BootstrapTokenRow extends RowDataPacket {
  id: string;
  token_hash: string;
  cluster_id: string;
  node_role: BootstrapNodeRole;
  labels_json: string | Record<string, string>;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  claim_id: string | null;
  completed_node_id: string | null;
  created_at: Date;
}

@Injectable()
export class BootstrapRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async create(input: {
    id: string;
    tokenHash: string;
    clusterId: string;
    nodeRole: BootstrapNodeRole;
    labels: Record<string, string>;
    createdBy: string;
    ttlSeconds: number;
  }): Promise<BootstrapTokenRecord> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO bootstrap_tokens
         (
           id, token_hash, cluster_id, node_role, labels_json,
           created_by, expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))`,
        [
          input.id,
          input.tokenHash,
          input.clusterId,
          input.nodeRole,
          JSON.stringify(input.labels),
          input.createdBy,
          input.ttlSeconds,
        ],
      );

      const record = await this.findByIdWithConnection(connection, input.id);
      if (!record) {
        throw new Error('Bootstrap token disappeared after insert');
      }

      await this.insertAuditOnce(connection, {
        tokenId: record.id,
        actorId: input.createdBy,
        clusterId: record.clusterId,
        action: 'BOOTSTRAP_TOKEN_ISSUED',
        afterJson: {
          nodeRole: record.nodeRole,
          labels: record.labels,
          expiresAt: record.expiresAt,
        },
      });

      await connection.commit();
      return record;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async findClaimableByHash(
    tokenHash: string,
    claimId: string,
  ): Promise<BootstrapTokenRecord | null> {
    const connection = await this.db.getConnection();
    try {
      const [rows] = await connection.query<BootstrapTokenRow[]>(
        `SELECT * FROM bootstrap_tokens
         WHERE token_hash = ?
           AND expires_at > UTC_TIMESTAMP(6)
           AND (used_at IS NULL OR claim_id = ?)
         LIMIT 1`,
        [tokenHash, claimId],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async consume(
    tokenHash: string,
    claimId: string,
  ): Promise<{ record: BootstrapTokenRecord; replayed: boolean } | null> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query<BootstrapTokenRow[]>(
        `SELECT * FROM bootstrap_tokens
         WHERE token_hash = ?
           AND expires_at > UTC_TIMESTAMP(6)
         LIMIT 1
         FOR UPDATE`,
        [tokenHash],
      );
      const current = rows[0];
      if (!current) {
        await connection.rollback();
        return null;
      }

      if (current.used_at !== null) {
        if (current.claim_id !== claimId) {
          await connection.rollback();
          return null;
        }

        const record = mapRow(current);
        await this.insertAuditOnce(connection, {
          tokenId: record.id,
          actorId: `bootstrap:${record.id}`,
          clusterId: record.clusterId,
          action: 'BOOTSTRAP_TOKEN_CLAIMED',
          afterJson: {
            claimId,
            nodeRole: record.nodeRole,
            labels: record.labels,
            claimedAt: record.usedAt,
          },
        });
        await connection.commit();
        return {
          record,
          replayed: true,
        };
      }

      await connection.execute(
        `UPDATE bootstrap_tokens
         SET used_at = UTC_TIMESTAMP(6), claim_id = ?
         WHERE id = ? AND used_at IS NULL`,
        [claimId, current.id],
      );

      const record = await this.findByHashWithConnection(
        connection,
        tokenHash,
      );
      if (!record || !record.usedAt || record.claimId !== claimId) {
        throw new Error('Consumed bootstrap token state is inconsistent');
      }

      await this.insertAuditOnce(connection, {
        tokenId: record.id,
        actorId: `bootstrap:${record.id}`,
        clusterId: record.clusterId,
        action: 'BOOTSTRAP_TOKEN_CLAIMED',
        afterJson: {
          claimId,
          nodeRole: record.nodeRole,
          labels: record.labels,
          claimedAt: record.usedAt,
        },
      });

      await connection.commit();
      return {
        record,
        replayed: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async bindCompletionNode(
    tokenId: string,
    claimId: string,
    nodeId: string,
  ): Promise<'BOUND' | 'REPLAY' | 'CONFLICT' | 'INACTIVE'> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query<BootstrapTokenRow[]>(
        `SELECT * FROM bootstrap_tokens
         WHERE id = ?
           AND expires_at > UTC_TIMESTAMP(6)
         LIMIT 1
         FOR UPDATE`,
        [tokenId],
      );
      const current = rows[0];
      if (
        !current ||
        current.used_at === null ||
        current.claim_id !== claimId
      ) {
        await connection.rollback();
        return 'INACTIVE';
      }

      if (current.completed_node_id !== null) {
        await connection.commit();
        return current.completed_node_id === nodeId
          ? 'REPLAY'
          : 'CONFLICT';
      }

      await connection.execute(
        `UPDATE bootstrap_tokens
         SET completed_node_id = ?
         WHERE id = ? AND completed_node_id IS NULL`,
        [nodeId, tokenId],
      );

      await connection.commit();
      return 'BOUND';
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordCompletionAudit(
    record: BootstrapTokenRecord,
    input: {
      nodeId: string;
      hostname: string;
      role: string;
      labels: Record<string, string>;
      verifiedAt: string;
    },
  ): Promise<void> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();

      const locked = await this.findRowByIdForUpdate(connection, record.id);
      if (
        !locked ||
        locked.claim_id !== record.claimId ||
        locked.used_at === null ||
        locked.completed_node_id !== input.nodeId
      ) {
        throw new Error(
          'Bootstrap token state changed before completion audit',
        );
      }

      await this.insertAuditOnce(connection, {
        tokenId: record.id,
        actorId: `bootstrap:${record.id}`,
        clusterId: record.clusterId,
        action: 'BOOTSTRAP_COMPLETED',
        afterJson: {
          claimId: record.claimId,
          nodeId: input.nodeId,
          hostname: input.hostname,
          role: input.role,
          labels: input.labels,
          verifiedAt: input.verifiedAt,
        },
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async insertAuditOnce(
    connection: PoolConnection,
    input: {
      tokenId: string;
      actorId: string;
      clusterId: string;
      action: string;
      afterJson: unknown;
    },
  ): Promise<void> {
    const [existing] = await connection.query<Array<RowDataPacket & { id: number }>>(
      `SELECT id FROM audit_events
       WHERE operation_id = ? AND action = ?
       LIMIT 1`,
      [input.tokenId, input.action],
    );
    if (existing.length > 0) {
      return;
    }

    await connection.execute(
      `INSERT INTO audit_events
       (
         operation_id, actor_id, cluster_id, service_id,
         resource_type, resource_id, action, before_json, after_json
       )
       VALUES (?, ?, ?, ?, 'bootstrap_token', ?, ?, NULL, ?)`,
      [
        input.tokenId,
        input.actorId,
        input.clusterId,
        input.tokenId,
        input.tokenId,
        input.action,
        JSON.stringify(input.afterJson),
      ],
    );
  }

  private async findByIdWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<BootstrapTokenRecord | null> {
    const [rows] = await connection.query<BootstrapTokenRow[]>(
      'SELECT * FROM bootstrap_tokens WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  private async findRowByIdForUpdate(
    connection: PoolConnection,
    id: string,
  ): Promise<BootstrapTokenRow | null> {
    const [rows] = await connection.query<BootstrapTokenRow[]>(
      'SELECT * FROM bootstrap_tokens WHERE id = ? LIMIT 1 FOR UPDATE',
      [id],
    );
    return rows[0] ?? null;
  }

  private async findByHashWithConnection(
    connection: PoolConnection,
    tokenHash: string,
  ): Promise<BootstrapTokenRecord | null> {
    const [rows] = await connection.query<BootstrapTokenRow[]>(
      'SELECT * FROM bootstrap_tokens WHERE token_hash = ? LIMIT 1',
      [tokenHash],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

function mapRow(row: BootstrapTokenRow): BootstrapTokenRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    nodeRole: row.node_role,
    labels:
      typeof row.labels_json === 'string'
        ? JSON.parse(row.labels_json) as Record<string, string>
        : row.labels_json,
    createdBy: row.created_by,
    expiresAt: row.expires_at.toISOString(),
    usedAt: row.used_at?.toISOString() ?? null,
    claimId: row.claim_id,
    createdAt: row.created_at.toISOString(),
  };
}
