import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import {
  AGENT_CLIENT,
  AgentRequestError,
  type AgentClient,
} from '../agent/agent-client.js';
import type {
  ServiceDetailResponse,
  ServiceMutationPlan,
  ServiceMutationResponse,
} from '../agent/read-model.js';
import type { Principal } from '../auth/auth.types.js';
import { CapacityService } from '../capacity/capacity.service.js';
import { NodeOperationRepository } from '../operations/node-operation.repository.js';
import { OperationLock } from '../operations/operation-lock.js';
import { OperationRepository } from '../operations/operation.repository.js';
import type { OperationRecord } from '../operations/operation.types.js';
import { ReleaseRepository } from '../releases/release.repository.js';
import type { DeployRequest } from './deployment.dto.js';
import { DeploymentRepository } from './deployment.repository.js';
import type { DeploymentRecord } from './deployment.types.js';
import { HealthVerifier } from './health-verifier.js';

const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 500;

@Injectable()
export class DeploymentService {
  constructor(
    @Inject(ReleaseRepository)
    private readonly releases: ReleaseRepository,
    @Inject(DeploymentRepository)
    private readonly deployments: DeploymentRepository,
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
    @Inject(OperationRepository)
    private readonly operations: OperationRepository,
    @Inject(NodeOperationRepository)
    private readonly nodeOperations: NodeOperationRepository,
    @Inject(OperationLock) private readonly lock: OperationLock,
    @Inject(CapacityService) private readonly capacity: CapacityService,
    @Inject(HealthVerifier) private readonly health: HealthVerifier,
  ) {}

  async history(
    clusterId: string,
    targetId: string,
  ): Promise<DeploymentRecord[]> {
    const target = await this.releases.findDeploymentTarget(targetId);
    if (!target || target.clusterId !== clusterId) {
      throw new NotFoundException('Deployment target not found');
    }
    return this.deployments.listForTarget(targetId);
  }

  async deployment(
    clusterId: string,
    id: string,
  ): Promise<DeploymentRecord> {
    const deployment = await this.deployments.find(id);
    if (!deployment) throw new NotFoundException('Deployment not found');
    const target = await this.releases.findDeploymentTarget(
      deployment.deploymentTargetId,
    );
    if (!target || target.clusterId !== clusterId) {
      throw new NotFoundException('Deployment not found');
    }
    return deployment;
  }

  async deploy(
    clusterId: string,
    targetId: string,
    input: DeployRequest,
    principal: Principal,
  ): Promise<DeploymentRecord> {
    const target = await this.releases.findDeploymentTarget(targetId);
    if (!target || target.clusterId !== clusterId) {
      throw new NotFoundException('Deployment target not found');
    }

    const release = await this.releases.findRelease(input.releaseId);
    if (!release || release.applicationId !== target.applicationId) {
      throw new NotFoundException('Release not found for deployment target');
    }

    let resolved: ServiceDetailResponse;
    try {
      resolved = await this.agentClient.inspectService(
        target.dockerServiceId,
      );
    } catch (error) {
      throw mapAgentError(error, 'Deployment target lookup failed');
    }
    if (
      resolved.service.id !== target.dockerServiceId ||
      resolved.service.mode !== 'replicated'
    ) {
      throw new ConflictException(
        'Deployment target no longer resolves to the expected replicated service',
      );
    }

    return this.lock.withServiceLock(
      clusterId,
      target.dockerServiceId,
      async (connection) => {
        const existing = await this.operations.findWithConnection(
          connection,
          input.operationId,
        );
        if (existing) {
          this.assertIdempotent(existing, principal.actorId, target.dockerServiceId);
          const deployment =
            await this.deployments.findByOperationWithConnection(
              connection,
              input.operationId,
            );
          if (!deployment) {
            throw new ConflictException(
              'Deployment operation exists without deployment record',
            );
          }
          if (
            deployment.releaseId !== input.releaseId ||
            deployment.deploymentTargetId !== targetId ||
            deployment.createdBy !== principal.actorId ||
            JSON.stringify(deployment.health) !== JSON.stringify(input.health)
          ) {
            throw new ConflictException(
              'operationId was already used for a different deployment',
            );
          }
          return deployment;
        }

        const prior =
          await this.operations.findNonTerminalForServiceWithConnection(
            connection,
            clusterId,
            target.dockerServiceId,
          );
        if (prior) {
          throw new ConflictException(
            `Service has unresolved operation ${prior.id} (${prior.status})`,
          );
        }

        const nodeConflict =
          await this.nodeOperations.findNonTerminalAffectingServiceWithConnection(
            connection,
            clusterId,
            target.dockerServiceId,
          );
        if (nodeConflict) {
          throw new ConflictException(
            `Service is affected by unresolved node operation ${nodeConflict.id}`,
          );
        }

        const before = await this.agentClient.inspectService(
          target.dockerServiceId,
        );
        const targetImage = dockerImageReference(
          release.imageRepository,
          release.imageDigest,
        );

        let plan: ServiceMutationPlan;
        try {
          plan = await this.agentClient.planUpdateServiceImage(
            target.dockerServiceId,
            before.service.version,
            targetImage,
          );
        } catch (error) {
          throw mapAgentError(error, 'Deployment planning failed');
        }
        assertPlanMatchesCurrent(plan, before);

        const noOp = plan.beforeSpecHash === plan.targetSpecHash;
        if (!noOp) {
          await this.capacity.assertAvailable(target.dockerServiceId, {
            expectedVersion: plan.version,
            targetReplicas: before.service.desiredReplicas,
            includeUpdateOverlap: true,
          });
        }
        const deployment = await this.persistIntent(
          connection,
          clusterId,
          targetId,
          release.id,
          input,
          principal,
          plan,
          before,
          targetImage,
          noOp,
        );

        if (noOp) {
          await this.markVerifying(
            connection,
            deployment.id,
            input.operationId,
            before.service.version,
          );
          return this.verifyAndComplete(
            connection,
            deployment.id,
            input.operationId,
            plan,
            release.imageDigest,
            true,
            input.health,
          );
        }

        let accepted: ServiceMutationResponse;
        try {
          accepted = await this.agentClient.updateServiceImage(
            target.dockerServiceId,
            {
              expectedVersion: plan.version,
              expectedSpecHash: plan.beforeSpecHash,
              targetSpecHash: plan.targetSpecHash,
              image: targetImage,
            },
          );
        } catch (error) {
          if (
            error instanceof AgentRequestError &&
            (error.statusCode === 400 || error.statusCode === 409)
          ) {
            await this.fail(
              connection,
              deployment.id,
              input.operationId,
              'AGENT_MUTATION_REJECTED',
              error.responseBody,
            );
            throw mapAgentError(error, 'Deployment mutation failed');
          }

          await this.attention(
            connection,
            deployment.id,
            input.operationId,
            `Deployment mutation outcome is uncertain: ${errorMessage(error)}`,
          );
          return this.deployments.requireWithConnection(
            connection,
            deployment.id,
          );
        }

        if (
          accepted.serviceId !== plan.serviceId ||
          accepted.targetSpecHash !== plan.targetSpecHash
        ) {
          await this.attention(
            connection,
            deployment.id,
            input.operationId,
            'Agent response did not match deployment plan',
          );
          return this.deployments.requireWithConnection(
            connection,
            deployment.id,
          );
        }

        await this.markVerifying(
          connection,
          deployment.id,
          input.operationId,
          accepted.version,
        );

        return this.verifyAndComplete(
          connection,
          deployment.id,
          input.operationId,
          plan,
          release.imageDigest,
          false,
          input.health,
        );
      },
    );
  }

  private async persistIntent(
    connection: PoolConnection,
    clusterId: string,
    targetId: string,
    releaseId: string,
    input: DeployRequest,
    principal: Principal,
    plan: ServiceMutationPlan,
    before: ServiceDetailResponse,
    targetImage: string,
    noOp: boolean,
  ): Promise<DeploymentRecord> {
    await connection.beginTransaction();
    try {
      const previousReleaseId =
        await this.deployments.latestSuccessfulReleaseId(
          connection,
          targetId,
        );

      await this.operations.create(connection, {
        id: input.operationId,
        clusterId,
        serviceId: plan.serviceId,
        type: 'DEPLOY',
        actorId: principal.actorId,
        expectedVersion: plan.version,
        beforeSpecHash: plan.beforeSpecHash,
        targetSpecHash: plan.targetSpecHash,
        targetForceUpdate: plan.targetForceUpdate,
        targetReplicas: before.service.desiredReplicas,
        targetImage,
      });
      await this.operations.markRunning(connection, input.operationId);

      const deployment = await this.deployments.create(connection, {
        releaseId,
        previousReleaseId,
        deploymentTargetId: targetId,
        operationId: input.operationId,
        status: noOp ? 'VERIFYING' : 'DEPLOYING',
        noOp,
        beforeSpec: before.service,
        targetSpec: {
          specHash: plan.targetSpecHash,
          image: targetImage,
          desiredReplicas: before.service.desiredReplicas,
        },
        health: input.health,
        expectedServiceVersion: plan.version,
        createdBy: principal.actorId,
      });

      await this.operations.audit(connection, {
        operationId: input.operationId,
        actorId: principal.actorId,
        clusterId,
        serviceId: plan.serviceId,
        resourceType: 'service',
        resourceId: plan.serviceId,
        action: noOp ? 'DEPLOY_NO_OP_STARTED' : 'DEPLOY_STARTED',
        beforeJson: before.service,
        afterJson: deployment.targetSpec,
      });
      await connection.commit();
      return deployment;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async markVerifying(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    resultVersion: number,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markVerifying(
        connection,
        operationId,
        resultVersion,
      );
      await this.deployments.markVerifying(connection, deploymentId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async verifyAndComplete(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    plan: ServiceMutationPlan,
    digest: string,
    noOp: boolean,
    health: DeployRequest['health'],
  ): Promise<DeploymentRecord> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      try {
        const current = await this.agentClient.inspectService(plan.serviceId);
        const decision = classifyDeploymentSnapshot(
          current,
          plan,
          digest,
          noOp,
        );

        if (decision === 'SUCCESS') {
          try {
            await this.health.verify(health);
          } catch (error) {
            await this.fail(
              connection,
              deploymentId,
              operationId,
              'HEALTH_VERIFICATION_FAILED',
              errorMessage(error),
            );
            return this.deployments.requireWithConnection(
              connection,
              deploymentId,
            );
          }

          await connection.beginTransaction();
          try {
            await this.operations.markSuccess(
              connection,
              operationId,
              current.service.version,
            );
            await this.deployments.markSuccess(connection, deploymentId);
            const operation = await this.operations.findWithConnection(
              connection,
              operationId,
            );
            if (!operation) throw new Error('Deployment operation disappeared');
            await this.operations.audit(connection, {
              operationId,
              actorId: operation.actorId,
              clusterId: operation.clusterId,
              serviceId: operation.serviceId,
              action: noOp ? 'DEPLOY_NO_OP_SUCCEEDED' : 'DEPLOY_SUCCEEDED',
              afterJson: current.service,
            });
            await connection.commit();
          } catch (error) {
            await connection.rollback();
            throw error;
          }
          return this.deployments.requireWithConnection(
            connection,
            deploymentId,
          );
        }

        if (decision === 'FAILED') {
          await this.fail(
            connection,
            deploymentId,
            operationId,
            'CONVERGENCE_FAILED',
            'Swarm update entered a failed or rollback state',
          );
          return this.deployments.requireWithConnection(connection, deploymentId);
        }

        if (decision === 'EXTERNAL_CONFLICT') {
          await this.attention(
            connection,
            deploymentId,
            operationId,
            'Current service spec diverged from the deployment target',
          );
          return this.deployments.requireWithConnection(connection, deploymentId);
        }
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
      }
      await sleep(VERIFY_INTERVAL_MS);
    }

    await this.fail(
      connection,
      deploymentId,
      operationId,
      'DEPLOYMENT_TIMEOUT',
      lastError
        ? `Deployment verification timed out after Agent errors: ${lastError}`
        : 'Deployment did not converge before timeout',
    );
    return this.deployments.requireWithConnection(connection, deploymentId);
  }

  private async fail(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markFailed(connection, operationId, code, message);
      await this.deployments.markFailed(connection, deploymentId, message);
      const operation = await this.operations.findWithConnection(
        connection,
        operationId,
      );
      if (!operation) throw new Error('Deployment operation disappeared');
      await this.operations.audit(connection, {
        operationId,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'DEPLOY_FAILED',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async attention(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markNeedsAttention(
        connection,
        operationId,
        'EXTERNAL_SERVICE_CONFLICT',
        message,
      );
      await this.deployments.markNeedsAttention(
        connection,
        deploymentId,
        message,
      );
      const operation = await this.operations.findWithConnection(
        connection,
        operationId,
      );
      if (!operation) throw new Error('Deployment operation disappeared');
      await this.operations.audit(connection, {
        operationId,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'DEPLOY_NEEDS_ATTENTION',
        afterJson: { message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private assertIdempotent(
    operation: OperationRecord,
    actorId: string,
    serviceId: string,
  ): void {
    if (
      operation.type !== 'DEPLOY' ||
      operation.actorId !== actorId ||
      operation.serviceId !== serviceId
    ) {
      throw new ConflictException(
        'operationId was already used for a different mutation',
      );
    }
  }
}

type DeploymentDecision =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXTERNAL_CONFLICT';

export function classifyDeploymentSnapshot(
  current: ServiceDetailResponse,
  plan: ServiceMutationPlan,
  digest: string,
  noOp: boolean,
): DeploymentDecision {
  if (current.service.specHash !== plan.targetSpecHash) {
    if (current.service.version > plan.version) return 'EXTERNAL_CONFLICT';
    return 'PENDING';
  }

  if (!imageContainsDigest(current.service.image, digest)) return 'PENDING';

  const updateState = current.service.updateState;
  if (
    updateState === 'paused' ||
    updateState === 'rollback_started' ||
    updateState === 'rollback_completed'
  ) {
    return 'FAILED';
  }

  if (!noOp && updateState !== 'completed') return 'PENDING';
  if (current.service.desiredReplicas !== current.service.runningReplicas) {
    return 'PENDING';
  }

  const running = current.tasks.filter((task) => task.state === 'running');
  if (
    running.length !== current.service.desiredReplicas ||
    !running.every(
      (task) =>
        imageContainsDigest(task.image, digest) &&
        task.forceUpdate === plan.targetForceUpdate,
    )
  ) {
    return 'PENDING';
  }
  return 'SUCCESS';
}

export function dockerImageReference(repository: string, digest: string): string {
  const withoutScheme = repository.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `${withoutScheme}@${digest.toLowerCase()}`;
}

function imageContainsDigest(
  image: string | undefined,
  digest: string,
): boolean {
  return Boolean(
    image &&
      image.toLowerCase().includes(`@${digest.toLowerCase()}`),
  );
}

function mapAgentError(error: unknown, fallback: string): Error {
  if (error instanceof AgentRequestError) {
    if (error.statusCode === 409) {
      return new ConflictException('Service changed during deployment');
    }
    return new BadGatewayException(
      `${fallback}: Agent returned HTTP ${error.statusCode}`,
    );
  }
  return new BadGatewayException(`${fallback}: ${errorMessage(error)}`);
}

function assertPlanMatchesCurrent(
  plan: ServiceMutationPlan,
  current: ServiceDetailResponse,
): void {
  if (
    plan.serviceId !== current.service.id ||
    plan.version !== current.service.version ||
    plan.beforeSpecHash !== current.service.specHash
  ) {
    throw new ConflictException(
      'Service changed between deployment inspection and planning',
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
