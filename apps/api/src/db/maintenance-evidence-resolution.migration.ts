import type { PoolConnection } from 'mysql2/promise';

/**
 * Immutable evidence rows are not deleted during administrative recovery.
 * One explicit, audited resolution references each evidence row. A second
 * recovery attempt cannot silently overwrite the first operator's decision.
 */
export async function migrateMaintenanceEvidenceResolution(connection: PoolConnection): Promise<void> {
  for (const column of [
    "owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL",
    "resource_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL",
    "resource_id VARCHAR(128) NULL",
    "operation_id VARCHAR(64) NULL",
  ]) {
    const name = column.split(' ')[0];
    const [rows] = await connection.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema=DATABASE() AND table_name='maintenance_active_admissions' AND column_name=?`,
      [name],
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      await connection.query(`ALTER TABLE maintenance_active_admissions ADD COLUMN ${column}`);
    }
  }
  await connection.query(`
    CREATE TABLE IF NOT EXISTS maintenance_evidence_resolutions (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      cluster_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      evidence_type ENUM('ADMISSION','DISPATCH') NOT NULL,
      evidence_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      actor_id VARCHAR(128) NOT NULL,
      reason VARCHAR(1024) NOT NULL,
      evidence_json JSON NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_maintenance_evidence_resolution (cluster_id, evidence_type, evidence_id),
      CONSTRAINT fk_maintenance_resolution_cluster FOREIGN KEY (cluster_id)
        REFERENCES cluster_maintenance_states(cluster_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  `);
}
