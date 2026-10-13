import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { Database } from '../db/database.js';

/**
 * Readiness evidence only. No Agent barrier can be inferred from an empty table:
 * expected manager membership must be independently fixed and verified.
 * PREPARED is conservatively unresolved after a crash.
 */
@Injectable()
export class MaintenanceDispatchEvidence {
  constructor(@Inject(Database) private readonly db: Database) {}

  async countUnresolved(clusterId: string): Promise<bigint> {
    try {
      const [rows] = await this.db.query<(RowDataPacket & { count: string })[]>(
        `SELECT CAST(COUNT(*) AS CHAR) AS count FROM maintenance_dispatches
         WHERE cluster_id = ? AND phase IN ('PREPARED','SENDING','UNCERTAIN')`,
        [clusterId],
      );
      if (!rows[0] || !/^[0-9]+$/.test(String(rows[0].count))) throw new Error('Invalid count');
      return BigInt(rows[0].count);
    } catch {
      throw new ServiceUnavailableException('Dispatch evidence unavailable');
    }
  }
}
