import type { PoolConnection } from 'mysql2/promise';

/**
 * Durable per-callback admission evidence. A CP crash deliberately leaves the
 * row behind; absence of a heartbeat is NEVER proof an HTTP mutation was not
 * sent. Operators must reconcile stale evidence before declaring CLOSED.
 *
 * This migration is additive and does not create or release admissions.
 */
export async function migrateMaintenanceActiveAdmissions(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS maintenance_active_admissions (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      generation BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_maintenance_active_cluster (cluster_id),
      CONSTRAINT fk_maintenance_active_cluster FOREIGN KEY (cluster_id)
        REFERENCES cluster_maintenance_states(cluster_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
