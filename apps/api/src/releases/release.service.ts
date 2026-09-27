import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AGENT_CLIENT, type AgentClient } from '../agent/agent-client.js';
import type { Principal } from '../auth/auth.types.js';
import {
  RegistryClient,
  RegistryRequestError,
} from '../registry/registry.client.js';
import type {
  CreateApplicationRequest,
  CreateDeploymentTargetRequest,
  CreateReleaseRequest,
} from './release.dto.js';
import { ReleaseRepository } from './release.repository.js';
import type {
  ApplicationRecord,
  DeploymentTargetRecord,
  ReleaseRecord,
} from './release.types.js';

@Injectable()
export class ReleaseService {
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(ReleaseRepository)
    private readonly repository: ReleaseRepository,
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
    @Inject(RegistryClient) private readonly registryClient: RegistryClient,
  ) {}

  applications(): Promise<ApplicationRecord[]> {
    return this.repository.listApplications();
  }

  async createApplication(
    input: CreateApplicationRequest,
  ): Promise<ApplicationRecord> {
    try {
      return await this.repository.createApplication(input);
    } catch (error) {
      throw mapDuplicate(error, 'Application name already exists');
    }
  }

  async targets(
    clusterId: string,
    applicationId: string,
  ): Promise<DeploymentTargetRecord[]> {
    this.assertCluster(clusterId);
    await this.requireApplication(applicationId);
    return this.repository.listDeploymentTargets(applicationId, clusterId);
  }

  async createTarget(
    clusterId: string,
    applicationId: string,
    input: CreateDeploymentTargetRequest,
  ): Promise<DeploymentTargetRecord> {
    this.assertCluster(clusterId);
    await this.requireApplication(applicationId);

    let service;
    try {
      service = await this.agentClient.inspectService(input.dockerServiceId);
    } catch {
      throw new NotFoundException('Swarm service not found');
    }

    try {
      return await this.repository.createDeploymentTarget(
        applicationId,
        clusterId,
        {
          ...input,
          dockerServiceId: service.service.id,
          serviceName: service.service.name,
          routingMode: 'INGRESS',
        },
      );
    } catch (error) {
      throw mapDuplicate(
        error,
        'Deployment target already exists for the service or environment',
      );
    }
  }

  async releases(applicationId: string): Promise<ReleaseRecord[]> {
    await this.requireApplication(applicationId);
    return this.repository.listReleases(applicationId);
  }

  async createRelease(
    applicationId: string,
    input: CreateReleaseRequest,
    principal: Principal,
  ): Promise<ReleaseRecord> {
    await this.requireApplication(applicationId);

    const reference = input.imageDigest ?? input.imageTag;
    if (!reference) {
      throw new BadRequestException('Release image reference is required');
    }

    let artifact;
    try {
      artifact = await this.registryClient.resolve(
        input.imageRepository,
        reference,
      );
    } catch (error) {
      throw mapRegistryError(error);
    }

    if (
      input.imageDigest &&
      artifact.digest.toLowerCase() !== input.imageDigest.toLowerCase()
    ) {
      throw new BadRequestException(
        'Registry digest does not match requested imageDigest',
      );
    }

    const resolvedInput = {
      ...input,
      imageDigest: artifact.digest,
    };

    try {
      return await this.repository.createRelease(
        applicationId,
        resolvedInput,
        principal.actorId,
      );
    } catch (error) {
      throw mapDuplicate(error, 'Release version already exists');
    }
  }

  private async requireApplication(id: string): Promise<ApplicationRecord> {
    const application = await this.repository.findApplication(id);
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
  }
}

function mapDuplicate(error: unknown, message: string): Error {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  ) {
    return new ConflictException(message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function mapRegistryError(error: unknown): Error {
  if (!(error instanceof RegistryRequestError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (error.code === 'MANIFEST_NOT_FOUND') {
    return new NotFoundException(error.message);
  }
  if (
    error.code === 'INVALID_REPOSITORY' ||
    error.code === 'INVALID_DIGEST'
  ) {
    return new BadRequestException(error.message);
  }

  return new BadGatewayException(error.message);
}
