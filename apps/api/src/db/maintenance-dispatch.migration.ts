import type { PoolConnection } from 'mysql2/promise';

/**
 * Durable evidence for maintenance coordination (not an atomic Docker fence).
 * A missing acknowledgement or an uncertain dispatch is never evidence that
 * manager mutation traffic has drained. No rows are inserted automatically.
 */
export async function migrateMaintenanceDispatch(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS maintenance_dispatches (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      generation BIGINT UNSIGNED NOT NULL,
      agent_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      operation_id VARCHAR(64) NOT NULL,
      phase ENUM('PREPARED','SENDING','ACKNOWLEDGED','REJECTED','UNCERTAIN') NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_dispatch_unresolved (cluster_id, phase),
      CONSTRAINT fk_maintenance_dispatch_cluster FOREIGN KEY (cluster_id)
        REFERENCES cluster_maintenance_states(cluster_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS maintenance_agent_barriers (
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      agent_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      generation BIGINT UNSIGNED NOT NULL,
      state ENUM('PENDING','ACKNOWLEDGED') NOT NULL,
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (cluster_id, agent_id),
      CONSTRAINT fk_maintenance_barrier_cluster FOREIGN KEY (cluster_id)
        REFERENCES cluster_maintenance_states(cluster_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
