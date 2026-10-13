import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';

/**
 * Durable maintenance read boundary shared by all Control Plane processes.
 *
 * Missing row, invalid state and DB failure MUST NOT become OPEN. This module
 * does not authorize transitions, gate mutation dispatch or fence Docker CLI.
 * Those operations require a later coordinated admission/barrier implementation.
 */
export type MaintenanceState = 'OPEN' | 'CLOSING' | 'CLOSED' | 'RECONCILING';
export interface MaintenanceRecord {
  clusterId: string;
  state: MaintenanceState;
  generation: bigint;
  ownerId: string;
  reason: string;
  changedBy: string;
  changedAt: Date;
}
interface MaintenanceRow extends RowDataPacket {
  cluster_id: string;
  state: string;
  generation: string | number;
  owner_id: string;
  reason: string;
  changed_by: string;
  changed_at: Date;
}
const STATES = new Set<MaintenanceState>(['OPEN', 'CLOSING', 'CLOSED', 'RECONCILING']);

@Injectable()
export class ClusterMaintenanceRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async requireRecord(clusterId: string): Promise<MaintenanceRecord> {
    let rows: MaintenanceRow[];
    try {
      [rows] = await this.db.query<MaintenanceRow[]>(
        'SELECT cluster_id, state, generation, owner_id, reason, changed_by, changed_at FROM cluster_maintenance_states WHERE cluster_id = ? LIMIT 1',
        [clusterId],
      );
    } catch {
      throw new ServiceUnavailableException('Cluster maintenance state cannot be verified');
    }
    const row = rows[0];
    if (!row || !STATES.has(row.state as MaintenanceState)) {
      throw new ServiceUnavailableException('Cluster maintenance state is missing or invalid');
    }
    const generation = BigInt(row.generation);
    if (generation < 1n) {
      throw new ConflictException('Cluster maintenance generation is invalid');
    }
    return {
      clusterId: row.cluster_id,
      state: row.state as MaintenanceState,
      generation,
      ownerId: row.owner_id,
      reason: row.reason,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
    };
  }

  async requireOpen(clusterId: string): Promise<MaintenanceRecord> {
    const record = await this.requireRecord(clusterId);
    if (record.state !== 'OPEN') {
      throw new ConflictException('Cluster is in maintenance; mutation is blocked');
    }
    return record;
  }
}
