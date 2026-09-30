import { createHash } from 'node:crypto';
import type {
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise';

const MIGRATION_LOCK = 'docklane:schema-migrations';
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

interface MigrationRow extends RowDataPacket {
  version: number;
  name: string;
  checksum: string;
}

interface LockRow extends RowDataPacket {
  acquired: number | null;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface Migration {
  version: number;
  name: string;
  signature: string;
  up: (connection: PoolConnection) => Promise<void>;
}

export const DATABASE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline-current-schema',
    signature: '2026-10-01-baseline-current-schema-v1',
    up: migrateBaselineCurrentSchema,
  },
];

export async function runDatabaseMigrations(
  connection: PoolConnection,
): Promise<void> {
  const [lockRows] = await connection.query<LockRow[]>(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [MIGRATION_LOCK, MIGRATION_LOCK_TIMEOUT_SECONDS],
  );
  if (Number(lockRows[0]?.acquired ?? 0) !== 1) {
    throw new Error('Could not acquire Docklane database migration lock');
  }

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT UNSIGNED PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB
    `);

    const [rows] = await connection.query<MigrationRow[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC',
    );
    const applied = new Map(
      rows.map((row) => [Number(row.version), row]),
    );
    const known = new Map(
      DATABASE_MIGRATIONS.map((migration) => [migration.version, migration]),
    );
    const latestVersion =
      DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1]?.version ?? 0;

    for (const row of rows) {
      const migration = known.get(Number(row.version));
      if (!migration) {
        if (Number(row.version) > latestVersion) {
          throw new Error(
            `Database schema version ${row.version} is newer than this Docklane build (latest ${latestVersion})`,
          );
        }
        throw new Error(
          `Database contains unknown migration version ${row.version}`,
        );
      }

      const checksum = migrationChecksum(migration);
      if (row.name !== migration.name || row.checksum !== checksum) {
        throw new Error(
          `Database migration ${row.version} metadata does not match this Docklane build`,
        );
      }
    }

    for (const migration of DATABASE_MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      await migration.up(connection);
      await connection.execute(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES (?, ?, ?)`,
        [
          migration.version,
          migration.name,
          migrationChecksum(migration),
        ],
      );
    }
  } finally {
    try {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]);
    } catch {
      // The dedicated migration connection is released by the caller, which
      // also releases any advisory locks held by that MySQL session.
    }
  }
}

export function migrationChecksum(migration: Pick<Migration, 'version' | 'name' | 'signature'>): string {
  return createHash('sha256')
    .update(`${migration.version}:${migration.name}:${migration.signature}`)
    .digest('hex');
}

async function migrateBaselineCurrentSchema(
  connection: PoolConnection,
): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      operation_id VARCHAR(64) NOT NULL,
      actor_id VARCHAR(128) NOT NULL,
      cluster_id VARCHAR(128) NOT NULL,
      service_id VARCHAR(128) NOT NULL,
      resource_type VARCHAR(32) NOT NULL DEFAULT 'service',
      resource_id VARCHAR(128) NOT NULL DEFAULT '',
      action VARCHAR(64) NOT NULL,
      before_json JSON NULL,
      after_json JSON NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_audit_operation (operation_id),
      INDEX idx_audit_resource (cluster_id, service_id, created_at)
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    connection,
    'audit_events',
    'resource_type',
    "VARCHAR(32) NOT NULL DEFAULT 'service'",
  );
  await ensureColumn(
    connection,
    'audit_events',
    'resource_id',
    "VARCHAR(128) NOT NULL DEFAULT ''",
  );
  await connection.query(`
    UPDATE audit_events
    SET resource_type = 'service',
        resource_id = service_id
    WHERE resource_id = ''
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_applications_name (name)
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS deployment_targets (
      id VARCHAR(64) PRIMARY KEY,
      application_id VARCHAR(64) NOT NULL,
      cluster_id VARCHAR(128) NOT NULL,
      environment VARCHAR(255) NOT NULL,
      docker_service_id VARCHAR(255) NOT NULL,
      service_name VARCHAR(255) NOT NULL,
      routing_mode VARCHAR(32) NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_target_cluster_service (cluster_id, docker_service_id),
      UNIQUE KEY uq_target_application_environment (application_id, environment),
      INDEX idx_targets_application (application_id),
      CONSTRAINT fk_targets_application
        FOREIGN KEY (application_id) REFERENCES applications(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id VARCHAR(64) PRIMARY KEY,
      application_id VARCHAR(64) NOT NULL,
      version VARCHAR(255) NOT NULL,
      image_repository VARCHAR(512) NOT NULL,
      image_tag VARCHAR(255) NULL,
      image_digest VARCHAR(80) NOT NULL,
      git_commit VARCHAR(128) NULL,
      build_number VARCHAR(128) NULL,
      created_by VARCHAR(128) NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_release_application_version (application_id, version),
      INDEX idx_releases_application_created (application_id, created_at),
      CONSTRAINT fk_releases_application
        FOREIGN KEY (application_id) REFERENCES applications(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS operations (
      id VARCHAR(64) PRIMARY KEY,
      cluster_id VARCHAR(128) NOT NULL,
      service_id VARCHAR(128) NOT NULL,
      type VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      actor_id VARCHAR(128) NOT NULL,
      expected_version BIGINT UNSIGNED NOT NULL,
      before_spec_hash VARCHAR(64) NOT NULL DEFAULT '',
      target_spec_hash VARCHAR(64) NOT NULL DEFAULT '',
      target_force_update BIGINT UNSIGNED NOT NULL DEFAULT 0,
      target_replicas INT NULL,
      target_image VARCHAR(1024) NULL,
      target_task_spec_hash VARCHAR(64) NULL,
      target_runtime_spec_hash VARCHAR(64) NULL,
      result_version BIGINT UNSIGNED NULL,
      error_code VARCHAR(64) NULL,
      error_message TEXT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_operations_service (cluster_id, service_id, created_at),
      INDEX idx_operations_status (status, updated_at)
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    connection,
    'operations',
    'before_spec_hash',
    "VARCHAR(64) NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    connection,
    'operations',
    'target_spec_hash',
    "VARCHAR(64) NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    connection,
    'operations',
    'target_force_update',
    'BIGINT UNSIGNED NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    connection,
    'operations',
    'target_image',
    'VARCHAR(1024) NULL',
  );
  await ensureColumn(
    connection,
    'operations',
    'target_task_spec_hash',
    'VARCHAR(64) NULL',
  );
  await ensureColumn(
    connection,
    'operations',
    'target_runtime_spec_hash',
    'VARCHAR(64) NULL',
  );

  await connection.query(`
    CREATE TABLE IF NOT EXISTS node_operations (
      id VARCHAR(64) PRIMARY KEY,
      cluster_id VARCHAR(128) NOT NULL,
      node_id VARCHAR(128) NOT NULL,
      type VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      actor_id VARCHAR(128) NOT NULL,
      expected_version BIGINT UNSIGNED NOT NULL,
      before_spec_hash VARCHAR(64) NOT NULL,
      target_spec_hash VARCHAR(64) NOT NULL,
      target_availability VARCHAR(16) NOT NULL,
      affected_service_ids JSON NOT NULL,
      target_labels JSON NULL,
      label_patch JSON NULL,
      result_version BIGINT UNSIGNED NULL,
      error_code VARCHAR(64) NULL,
      error_message TEXT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_node_operations_node (cluster_id, node_id, created_at),
      INDEX idx_node_operations_status (status, updated_at)
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    connection,
    'node_operations',
    'target_labels',
    'JSON NULL',
  );
  await ensureColumn(
    connection,
    'node_operations',
    'label_patch',
    'JSON NULL',
  );

  await connection.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id VARCHAR(64) PRIMARY KEY,
      kind VARCHAR(32) NOT NULL DEFAULT 'DEPLOY',
      source_deployment_id VARCHAR(64) NULL,
      release_id VARCHAR(64) NOT NULL,
      previous_release_id VARCHAR(64) NULL,
      deployment_target_id VARCHAR(64) NOT NULL,
      operation_id VARCHAR(64) NOT NULL,
      rollback_operation_id VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL,
      reason TEXT NULL,
      no_op BOOLEAN NOT NULL DEFAULT FALSE,
      before_spec JSON NOT NULL,
      target_spec JSON NOT NULL,
      health_json JSON NOT NULL,
      expected_service_version BIGINT UNSIGNED NOT NULL,
      started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      finished_at TIMESTAMP(6) NULL,
      created_by VARCHAR(128) NOT NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_deployments_operation (operation_id),
      UNIQUE KEY uq_deployments_rollback_operation (rollback_operation_id),
      INDEX idx_deployments_target_created (deployment_target_id, created_at),
      INDEX idx_deployments_status (status, created_at),
      CONSTRAINT fk_deployments_release
        FOREIGN KEY (release_id) REFERENCES releases(id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_deployments_previous_release
        FOREIGN KEY (previous_release_id) REFERENCES releases(id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_deployments_target
        FOREIGN KEY (deployment_target_id) REFERENCES deployment_targets(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    connection,
    'deployments',
    'rollback_operation_id',
    'VARCHAR(64) NULL',
  );
  await ensureColumn(
    connection,
    'deployments',
    'kind',
    "VARCHAR(32) NOT NULL DEFAULT 'DEPLOY'",
  );
  await ensureColumn(
    connection,
    'deployments',
    'source_deployment_id',
    'VARCHAR(64) NULL',
  );
  await ensureIndex(
    connection,
    'deployments',
    'uq_deployments_rollback_operation',
    'UNIQUE KEY uq_deployments_rollback_operation (rollback_operation_id)',
  );

  await connection.query(`
    CREATE TABLE IF NOT EXISTS bootstrap_tokens (
      id VARCHAR(64) PRIMARY KEY,
      token_hash CHAR(64) NOT NULL,
      cluster_id VARCHAR(128) NOT NULL,
      node_role VARCHAR(16) NOT NULL,
      labels_json JSON NOT NULL,
      created_by VARCHAR(128) NOT NULL,
      expires_at TIMESTAMP(6) NOT NULL,
      used_at TIMESTAMP(6) NULL,
      claim_id VARCHAR(64) NULL,
      completed_node_id VARCHAR(128) NULL,
      created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_bootstrap_token_hash (token_hash),
      INDEX idx_bootstrap_tokens_expiry (expires_at, used_at),
      INDEX idx_bootstrap_tokens_cluster (cluster_id, created_at)
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    connection,
    'bootstrap_tokens',
    'claim_id',
    'VARCHAR(64) NULL',
  );
  await ensureColumn(
    connection,
    'bootstrap_tokens',
    'completed_node_id',
    'VARCHAR(128) NULL',
  );
}

async function ensureColumn(
  connection: PoolConnection,
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(columnName);

  const [rows] = await connection.query<CountRow[]>(
    `SELECT COUNT(*) AS count
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName],
  );
  if ((rows[0]?.count ?? 0) > 0) {
    return;
  }

  await connection.query(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
  );
}

async function ensureIndex(
  connection: PoolConnection,
  tableName: string,
  indexName: string,
  definition: string,
): Promise<void> {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(indexName);

  const [rows] = await connection.query<CountRow[]>(
    `SELECT COUNT(*) AS count
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND index_name = ?`,
    [tableName, indexName],
  );
  if ((rows[0]?.count ?? 0) > 0) {
    return;
  }

  await connection.query(
    `ALTER TABLE ${tableName} ADD ${definition}`,
  );
}

function assertSafeIdentifier(value: string): void {
  if (!/^[a-z_]+$/.test(value)) {
    throw new Error(`Unsafe database identifier: ${value}`);
  }
}
