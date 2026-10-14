import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/**
 * One dispatch lineage per cluster/operation. Duplicate attempts must not
 * create another PREPARED record after an uncertain HTTP response.
 * The migration refuses duplicate historical rows; operators must reconcile
 * them rather than discarding evidence.
 */
export async function migrateMaintenanceDispatchUniqueness(connection: PoolConnection): Promise<void> {
  const [duplicates] = await connection.query<(RowDataPacket & { count: number })[]>(
    `SELECT cluster_id, operation_id, COUNT(*) AS count
     FROM maintenance_dispatches GROUP BY cluster_id, operation_id HAVING COUNT(*) > 1 LIMIT 1`,
  );
  if (duplicates.length > 0) {
    throw new Error('Duplicate maintenance dispatch evidence requires reconciliation before migration');
  }
  await connection.query(`
    ALTER TABLE maintenance_dispatches
    ADD UNIQUE KEY uq_maintenance_dispatch_operation (cluster_id, operation_id)
  `);
}
