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
  // DDL and schema_migrations bookkeeping are not one atomic MySQL transaction.
  // A retry after a crash must accept the already-created correct unique index.
  const [indexes] = await connection.query<(RowDataPacket & {
    column_name: string; non_unique: number; seq_in_index: number;
  })[]>(
    `SELECT column_name, non_unique, seq_in_index
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'maintenance_dispatches'
       AND index_name = 'uq_maintenance_dispatch_operation'
     ORDER BY seq_in_index`,
  );
  if (indexes.length > 0) {
    if (indexes.length !== 2 || indexes.some(i => Number(i.non_unique) !== 0) ||
        indexes[0]?.column_name !== 'cluster_id' || indexes[1]?.column_name !== 'operation_id') {
      throw new Error('Maintenance dispatch uniqueness index metadata mismatch');
    }
    return;
  }
  await connection.query(`
    ALTER TABLE maintenance_dispatches
    ADD UNIQUE KEY uq_maintenance_dispatch_operation (cluster_id, operation_id)
  `);
}
