import type { PoolConnection } from 'mysql2/promise';

/**
 * Corrects migration v5 owner_id ASCII mismatch without changing its checksum.
 * Actor IDs are Unicode in authentication and audit. Keep cluster_id ASCII
 * because it is a protocol-level logical identifier.
 */
export async function migrateMaintenanceOwnerUnicode(connection: PoolConnection): Promise<void> {
  await connection.query(`
    ALTER TABLE cluster_maintenance_states
    MODIFY COLUMN owner_id VARCHAR(128)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
  `);
}
