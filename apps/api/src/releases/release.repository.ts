import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AuditRepository } from '../audit/audit.repository.js';
import { Database } from '../db/database.js';
import type {
  CreateApplicationRequest,
  CreateDeploymentTargetRequest,
  ResolvedReleaseRequest,
} from './release.dto.js';
import type {
  ApplicationRecord,
  DeploymentTargetRecord,
  ReleaseRecord,
} from './release.types.js';

interface ApplicationRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeploymentTargetRow extends RowDataPacket {
  id: string;
  application_id: string;
  cluster_id: string;
  environment: string;
  docker_service_id: string;
  service_name: string;
  routing_mode: 'INGRESS';
  created_at: Date;
  updated_at: Date;
}

interface ReleaseRow extends RowDataPacket {
  id: string;
  application_id: string;
  version: string;
  image_repository: string;
  image_tag: string | null;
  image_digest: string;
  git_commit: string | null;
  build_number: string | null;
  created_by: string;
  created_at: Date;
}

@Injectable()
export class ReleaseRepository {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  async createApplication(
    input: CreateApplicationRequest,
    actorId: string,
  ): Promise<ApplicationRecord> {
    const id = randomUUID();
    return this.inTransaction(async (connection) => {
      await connection.execute(
        'INSERT INTO applications (id, name, description) VALUES (?, ?, ?)',
        [id, input.name, input.description ?? null],
      );
      const created = await this.requireApplicationWithConnection(connection, id);
      await this.audit.record(connection, {
        eventId: randomUUID(),
        actorId,
        clusterId: 'global',
        resourceType: 'application',
        resourceId: id,
        action: 'APPLICATION_CREATED',
        afterJson: created,
      });
      return created;
    });
  }

  async listApplications(): Promise<ApplicationRecord[]> {
    const [rows] = await this.db.pool.query<ApplicationRow[]>(
      'SELECT * FROM applications ORDER BY name ASC',
    );
    return rows.map(mapApplication);
  }

  async findApplication(id: string): Promise<ApplicationRecord | null> {
    const [rows] = await this.db.pool.query<ApplicationRow[]>(
      'SELECT * FROM applications WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapApplication(rows[0]) : null;
  }

  async createDeploymentTarget(
    applicationId: string,
    clusterId: string,
    input: CreateDeploymentTargetRequest,
    actorId: string,
  ): Promise<DeploymentTargetRecord> {
    const id = randomUUID();
    return this.inTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO deployment_targets
         (id, application_id, cluster_id, environment, docker_service_id, service_name, routing_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          applicationId,
          clusterId,
          input.environment,
          input.dockerServiceId,
          input.serviceName,
          input.routingMode,
        ],
      );
      const created = await this.requireDeploymentTargetWithConnection(
        connection,
        id,
      );
      await this.audit.record(connection, {
        eventId: randomUUID(),
        actorId,
        clusterId,
        resourceType: 'deployment_target',
        resourceId: id,
        action: 'DEPLOYMENT_TARGET_CREATED',
        afterJson: created,
      });
      return created;
    });
  }

  async findDeploymentTarget(
    id: string,
  ): Promise<DeploymentTargetRecord | null> {
    const [rows] = await this.db.pool.query<DeploymentTargetRow[]>(
      'SELECT * FROM deployment_targets WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapDeploymentTarget(rows[0]) : null;
  }

  async listDeploymentTargets(
    applicationId: string,
    clusterId: string,
  ): Promise<DeploymentTargetRecord[]> {
    const [rows] = await this.db.pool.query<DeploymentTargetRow[]>(
      `SELECT * FROM deployment_targets
       WHERE application_id = ? AND cluster_id = ?
       ORDER BY environment ASC`,
      [applicationId, clusterId],
    );
    return rows.map(mapDeploymentTarget);
  }

  async createRelease(
    applicationId: string,
    input: ResolvedReleaseRequest,
    createdBy: string,
  ): Promise<ReleaseRecord> {
    const id = randomUUID();
    return this.inTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO releases
         (id, application_id, version, image_repository, image_tag, image_digest, git_commit, build_number, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          applicationId,
          input.version,
          input.imageRepository,
          input.imageTag ?? null,
          input.imageDigest.toLowerCase(),
          input.gitCommit ?? null,
          input.buildNumber ?? null,
          createdBy,
        ],
      );
      const created = await this.requireReleaseWithConnection(connection, id);
      await this.audit.record(connection, {
        eventId: randomUUID(),
        actorId: createdBy,
        clusterId: 'global',
        resourceType: 'release',
        resourceId: id,
        action: 'RELEASE_CREATED',
        afterJson: created,
      });
      return created;
    });
  }

  async findRelease(id: string): Promise<ReleaseRecord | null> {
    const [rows] = await this.db.pool.query<ReleaseRow[]>(
      'SELECT * FROM releases WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRelease(rows[0]) : null;
  }

  async listReleases(applicationId: string): Promise<ReleaseRecord[]> {
    const [rows] = await this.db.pool.query<ReleaseRow[]>(
      `SELECT * FROM releases
       WHERE application_id = ?
       ORDER BY created_at DESC`,
      [applicationId],
    );
    return rows.map(mapRelease);
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async requireApplicationWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<ApplicationRecord> {
    const [rows] = await connection.query<ApplicationRow[]>(
      'SELECT * FROM applications WHERE id = ? LIMIT 1',
      [id],
    );
    if (!rows[0]) throw new Error('Application disappeared after insert');
    return mapApplication(rows[0]);
  }

  private async requireDeploymentTargetWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<DeploymentTargetRecord> {
    const [rows] = await connection.query<DeploymentTargetRow[]>(
      'SELECT * FROM deployment_targets WHERE id = ? LIMIT 1',
      [id],
    );
    if (!rows[0]) throw new Error('Deployment target disappeared after insert');
    return mapDeploymentTarget(rows[0]);
  }

  private async requireReleaseWithConnection(
    connection: PoolConnection,
    id: string,
  ): Promise<ReleaseRecord> {
    const [rows] = await connection.query<ReleaseRow[]>(
      'SELECT * FROM releases WHERE id = ? LIMIT 1',
      [id],
    );
    if (!rows[0]) throw new Error('Release disappeared after insert');
    return mapRelease(rows[0]);
  }
}

function mapApplication(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapDeploymentTarget(
  row: DeploymentTargetRow,
): DeploymentTargetRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    clusterId: row.cluster_id,
    environment: row.environment,
    dockerServiceId: row.docker_service_id,
    serviceName: row.service_name,
    routingMode: row.routing_mode,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRelease(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    version: row.version,
    imageRepository: row.image_repository,
    imageTag: row.image_tag,
    imageDigest: row.image_digest,
    gitCommit: row.git_commit,
    buildNumber: row.build_number,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
