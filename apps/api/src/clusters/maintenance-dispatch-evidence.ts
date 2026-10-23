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
        `SELECT CAST(COUNT(*) AS CHAR) AS count FROM maintenance_dispatches d
         WHERE d.cluster_id = ? AND d.phase IN ('PREPARED','SENDING','UNCERTAIN')
         AND NOT EXISTS (SELECT 1 FROM maintenance_evidence_resolutions r
           WHERE r.cluster_id=d.cluster_id AND r.evidence_type='DISPATCH' AND r.evidence_id=d.id)`,
        [clusterId],
      );
      if (!rows[0] || !/^[0-9]+$/.test(String(rows[0].count))) throw new Error('Invalid count');
      return BigInt(rows[0].count);
    } catch {
      throw new ServiceUnavailableException('Dispatch evidence unavailable');
    }
  }
}
