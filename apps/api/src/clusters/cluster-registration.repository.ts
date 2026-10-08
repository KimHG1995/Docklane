import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';
import { matchesRegistration, type ClusterRegistrationRecord } from './cluster-registration.types.js';

type RegistrationInput = Omit<ClusterRegistrationRecord, 'id' | 'createdAt'>;

interface RegistrationRow extends RowDataPacket {
  id: string;
  cluster_id: string;
  swarm_cluster_id: string;
  display_name: string;
  registered_by: string;
  verified_node_id: string;
  created_at: Date;
}

const SELECT_REGISTRATION = 'SELECT * FROM cluster_registrations WHERE cluster_id = ? LIMIT 1';

@Injectable()
export class ClusterRegistrationRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async find(clusterId: string): Promise<ClusterRegistrationRecord | null> {
    const [rows] = await this.db.query<RegistrationRow[]>(SELECT_REGISTRATION, [clusterId]);
    return rows[0] ? mapRegistration(rows[0]) : null;
  }

  async register(input: RegistrationInput): Promise<ClusterRegistrationRecord> {
    const requested = { ...input };
    const id = randomUUID();
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      let duplicateInsert = false;
      try {
        try {
          await connection.execute(
            `INSERT INTO cluster_registrations
             (id, cluster_id, swarm_cluster_id, display_name, registered_by, verified_node_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, requested.clusterId, requested.swarmClusterId, requested.displayName,
              requested.registeredBy, requested.verifiedNodeId],
          );
        } catch (error) {
          duplicateInsert = isDuplicateKey(error);
          throw error;
        }
        const record = await this.findWithConnection(connection, requested.clusterId);
        if (!record) throw new Error('Cluster registration disappeared after insertion');
        await connection.execute(
          `INSERT INTO audit_events
           (operation_id, actor_id, cluster_id, service_id, resource_type, resource_id, action, after_json)
           VALUES (?, ?, ?, ?, 'cluster', ?, 'CLUSTER_REGISTERED', ?)`,
          [record.id, record.registeredBy, record.clusterId, record.clusterId, record.clusterId,
            JSON.stringify(record)],
        );
        await connection.commit();
        return record;
      } catch (error) {
        // Roll back the transaction, not just the failed INSERT. Only a duplicate
        // of that INSERT permits a fresh read; audit/commit failures never do.
        await connection.rollback();
        if (duplicateInsert) {
          const existing = await this.findWithConnection(connection, requested.clusterId);
          if (existing && matchesRegistration(existing, requested)) return existing;
          throw new ConflictException('Cluster or Swarm identity is already registered');
        }
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  async findWithConnection(
    connection: PoolConnection,
    clusterId: string,
  ): Promise<ClusterRegistrationRecord | null> {
    const [rows] = await connection.query<RegistrationRow[]>(SELECT_REGISTRATION, [clusterId]);
    return rows[0] ? mapRegistration(rows[0]) : null;
  }
}

function isDuplicateKey(error: unknown): boolean {
  return error !== null && typeof error === 'object' &&
    'code' in error && error.code === 'ER_DUP_ENTRY' &&
    'errno' in error && error.errno === 1062;
}

function mapRegistration(row: RegistrationRow): ClusterRegistrationRecord {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    swarmClusterId: row.swarm_cluster_id,
    displayName: row.display_name,
    registeredBy: row.registered_by,
    verifiedNodeId: row.verified_node_id,
    createdAt: row.created_at.toISOString(),
  };
}
