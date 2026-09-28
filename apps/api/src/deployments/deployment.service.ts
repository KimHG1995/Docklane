import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import {
  AGENT_CLIENT,
  AgentRequestError,
  type AgentClient,
} from '../agent/agent-client.js';
import type {
  ServiceDetailResponse,
  ServiceImageMutationPlan,
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
import type {
  DeployRequest,
  RollbackRequest,
} from './deployment.dto.js';
import { DeploymentRepository } from './deployment.repository.js';
import type { DeploymentRecord } from './deployment.types.js';
import { HealthVerifier } from './health-verifier.js';

const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 500;
const RECONCILE_OBSERVATION_MS = 10_000;
const RECONCILE_INTERVAL_MS = 5_000;

@Injectable()
export class DeploymentService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DeploymentService.name);
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationRunning = false;
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

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcilePendingDeployments();
    this.reconciliationTimer = setInterval(() => {
      void this.reconcilePendingDeployments();
    }, RECONCILE_INTERVAL_MS);
    this.reconciliationTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }

  private async reconcilePendingDeployments(): Promise<void> {
    if (this.reconciliationRunning) return;
    this.reconciliationRunning = true;

    try {
      const pending = (await this.operations.listNonTerminal()).filter(
        (operation) =>
          (operation.type === 'DEPLOY' || operation.type === 'ROLLBACK') &&
          operation.status !== 'NEEDS_ATTENTION',
      );

      for (const operation of pending) {
        try {
          await this.lock.withServiceLock(
            operation.clusterId,
            operation.serviceId,
            async (connection) => {
              const current = await this.operations.findWithConnection(
                connection,
                operation.id,
              );
              if (
                !current ||
                (current.type !== 'DEPLOY' && current.type !== 'ROLLBACK') ||
                current.status === 'SUCCESS' ||
                current.status === 'FAILED' ||
                current.status === 'NEEDS_ATTENTION'
              ) {
                return;
              }

              const deployment =
                current.type === 'ROLLBACK'
                  ? await this.deployments.findByRollbackOperationWithConnection(
                      connection,
                      current.id,
                    )
                  : await this.deployments.findByOperationWithConnection(
                      connection,
                      current.id,
                    );
              if (!deployment) {
                this.logger.error(
                  `Deployment operation ${current.id} has no deployment record`,
                );
                return;
              }

              if (current.type === 'ROLLBACK') {
                await this.reconcileRollbackLocked(
                  connection,
                  current,
                  deployment,
                );
              } else {
                await this.reconcileLocked(connection, current, deployment);
              }
            },
          );
        } catch (error) {
          this.logger.error(
            `Failed to reconcile deployment operation ${operation.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } finally {
      this.reconciliationRunning = false;
    }
  }

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

  async rollback(
    clusterId: string,
    deploymentId: string,
    input: RollbackRequest,
    principal: Principal,
  ): Promise<DeploymentRecord> {
    const deployment = await this.deployments.find(deploymentId);
    if (!deployment) throw new NotFoundException('Deployment not found');

    const target = await this.releases.findDeploymentTarget(
      deployment.deploymentTargetId,
    );
    if (!target || target.clusterId !== clusterId) {
      throw new NotFoundException('Deployment not found');
    }
    const sameRollbackRequest =
      deployment.rollbackOperationId === input.operationId;
    if (!sameRollbackRequest && deployment.status !== 'FAILED') {
      throw new ConflictException(
        'Only FAILED deployments can be rolled back manually',
      );
    }
    if (!deployment.previousReleaseId) {
      throw new ConflictException(
        'Deployment does not have a previous release to roll back to',
      );
    }

    const previousRelease = await this.releases.findRelease(
      deployment.previousReleaseId,
    );
    if (
      !previousRelease ||
      previousRelease.applicationId !== target.applicationId
    ) {
      throw new ConflictException(
        'Previous release is not valid for the deployment target',
      );
    }

    let resolved: ServiceDetailResponse;
    try {
      resolved = await this.agentClient.inspectService(
        target.dockerServiceId,
      );
    } catch (error) {
      throw mapAgentError(error, 'Rollback target lookup failed');
    }

    if (
      resolved.service.id !== target.dockerServiceId ||
      resolved.service.mode !== 'replicated'
    ) {
      throw new ConflictException(
        'Rollback target no longer resolves to the expected replicated service',
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
          this.assertRollbackIdempotent(
            existing,
            principal.actorId,
            target.dockerServiceId,
          );
          const existingDeployment =
            await this.deployments.findByRollbackOperationWithConnection(
              connection,
              input.operationId,
            );
          if (!existingDeployment || existingDeployment.id !== deployment.id) {
            throw new ConflictException(
              'operationId was already used for a different rollback',
            );
          }
          if (
            existing.status === 'SUCCESS' ||
            existing.status === 'FAILED'
          ) {
            return existingDeployment;
          }
          return this.reconcileRollbackLocked(
            connection,
            existing,
            existingDeployment,
          );
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

        let current: ServiceDetailResponse;
        try {
          current = await this.agentClient.inspectService(
            target.dockerServiceId,
          );
        } catch (error) {
          throw mapAgentError(error, 'Rollback precondition lookup failed');
        }

        const observingExistingRollback =
          current.service.updateState === 'rollback_started' ||
          current.service.updateState === 'rollback_completed';

        let plan: ServiceImageMutationPlan;
        if (observingExistingRollback) {
          plan = this.buildObservedRollbackPlan(
            deployment,
            previousRelease.imageDigest,
            current,
          );
        } else {
          try {
            plan = await this.agentClient.planRollbackService(
              target.dockerServiceId,
              current.service.version,
            );
          } catch (error) {
            throw mapAgentError(error, 'Rollback planning failed');
          }

          this.assertRollbackOwnership(
            deployment,
            previousRelease.imageDigest,
            plan,
            current,
          );

          await this.capacity.assertAvailable(target.dockerServiceId, {
            expectedVersion: plan.version,
            targetReplicas:
              plan.targetReplicas ?? current.service.desiredReplicas,
            includeUpdateOverlap: true,
          });
        }

        await this.persistRollbackIntent(
          connection,
          clusterId,
          deployment,
          principal,
          input.operationId,
          plan,
          current,
        );

        if (
          observingExistingRollback ||
          current.service.specHash === plan.targetSpecHash
        ) {
          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.reconcileRollbackLocked(
            connection,
            operation,
            deployment,
          );
        }

        let accepted: ServiceMutationResponse;
        try {
          accepted = await this.agentClient.rollbackService(
            target.dockerServiceId,
            {
              expectedVersion: plan.version,
              expectedSpecHash: plan.beforeSpecHash,
              targetSpecHash: plan.targetSpecHash,
            },
          );
        } catch (error) {
          if (
            error instanceof AgentRequestError &&
            (error.statusCode === 400 || error.statusCode === 409)
          ) {
            await this.rollbackFailed(
              connection,
              deployment.id,
              input.operationId,
              'ROLLBACK_REJECTED',
              error.responseBody,
            );
            throw mapAgentError(error, 'Rollback mutation failed');
          }

          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.reconcileRollbackLocked(
            connection,
            operation,
            deployment,
            errorMessage(error),
          );
        }

        if (
          accepted.serviceId !== plan.serviceId ||
          accepted.targetSpecHash !== plan.targetSpecHash ||
          accepted.targetForceUpdate !== plan.targetForceUpdate
        ) {
          await this.rollbackAttention(
            connection,
            deployment.id,
            input.operationId,
            'ROLLBACK_AGENT_RESPONSE_MISMATCH',
            'Agent rollback response did not match the recorded rollback target',
          );
          return this.deployments.requireWithConnection(
            connection,
            deployment.id,
          );
        }

        await this.markRollbackVerifying(
          connection,
          deployment.id,
          input.operationId,
          accepted.version,
        );

        return this.verifyRollbackAndComplete(
          connection,
          deployment.id,
          input.operationId,
          plan,
          previousRelease.imageDigest,
          deployment.health,
        );
      },
    );
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
            !sameHealthConfig(deployment.health, input.health)
          ) {
            throw new ConflictException(
              'operationId was already used for a different deployment',
            );
          }

          if (
            existing.status === 'SUCCESS' ||
            existing.status === 'FAILED'
          ) {
            return deployment;
          }

          return this.reconcileLocked(
            connection,
            existing,
            deployment,
          );
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

        let before: ServiceDetailResponse;
        try {
          before = await this.agentClient.inspectService(
            target.dockerServiceId,
          );
        } catch (error) {
          throw mapAgentError(error, 'Deployment precondition lookup failed');
        }
        const targetImage = dockerImageReference(
          release.imageRepository,
          release.imageDigest,
        );

        let plan: ServiceImageMutationPlan;
        try {
          plan = await this.agentClient.planUpdateServiceImage(
            target.dockerServiceId,
            before.service.version,
            targetImage,
          );
        } catch (error) {
          throw mapAgentError(error, 'Deployment planning failed');
        }
        assertPlanMatchesCurrent(plan, before, targetImage);

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

          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.reconcileLocked(
            connection,
            operation,
            deployment,
            errorMessage(error),
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
            'AGENT_RESPONSE_MISMATCH',
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

  private async persistRollbackIntent(
    connection: PoolConnection,
    clusterId: string,
    deployment: DeploymentRecord,
    principal: Principal,
    operationId: string,
    plan: ServiceImageMutationPlan,
    before: ServiceDetailResponse,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.create(connection, {
        id: operationId,
        clusterId,
        serviceId: plan.serviceId,
        type: 'ROLLBACK',
        actorId: principal.actorId,
        expectedVersion: plan.version,
        beforeSpecHash: plan.beforeSpecHash,
        targetSpecHash: plan.targetSpecHash,
        targetForceUpdate: plan.targetForceUpdate,
        targetReplicas: plan.targetReplicas,
        targetImage: plan.targetImage,
        targetTaskSpecHash: plan.targetTaskSpecHash,
      });
      await this.operations.markRunning(connection, operationId);
      await this.deployments.markRollingBack(
        connection,
        deployment.id,
        operationId,
      );
      await this.operations.audit(connection, {
        operationId,
        actorId: principal.actorId,
        clusterId,
        serviceId: plan.serviceId,
        action: 'ROLLBACK_STARTED',
        beforeJson: before.service,
        afterJson: {
          targetSpecHash: plan.targetSpecHash,
          targetImage: plan.targetImage,
          targetTaskSpecHash: plan.targetTaskSpecHash,
        },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async markRollbackVerifying(
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
      await this.deployments.markRollbackVerifying(
        connection,
        deploymentId,
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
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
        targetTaskSpecHash: plan.targetTaskSpecHash,
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
          taskSpecHash: plan.targetTaskSpecHash,
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
      let current: ServiceDetailResponse;
      try {
        current = await this.agentClient.inspectService(plan.serviceId);
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const decision = classifyDeploymentSnapshot(
        current,
        plan,
        digest,
        noOp,
      );

      if (decision === 'FAILED') {
        await this.fail(
          connection,
          deploymentId,
          operationId,
          'CONVERGENCE_FAILED',
          'Swarm update entered a terminal failed or rollback state',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }

      if (decision === 'EXTERNAL_CONFLICT') {
        await this.attention(
          connection,
          deploymentId,
          operationId,
          'EXTERNAL_SERVICE_CONFLICT',
          'Current service spec diverged from the deployment target',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }

      if (decision !== 'SUCCESS') {
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      try {
        await this.health.verify(health, async () => {
          let guarded: ServiceDetailResponse;
          try {
            guarded = await this.agentClient.inspectService(plan.serviceId);
          } catch (error) {
            throw new DeploymentConvergenceGuardError(
              'UNAVAILABLE',
              errorMessage(error),
            );
          }

          const guardedDecision = classifyDeploymentSnapshot(
            guarded,
            plan,
            digest,
            noOp,
          );
          if (guardedDecision !== 'SUCCESS') {
            throw new DeploymentConvergenceGuardError(guardedDecision);
          }
        });
      } catch (error) {
        if (error instanceof DeploymentConvergenceGuardError) {
          if (error.decision === 'EXTERNAL_CONFLICT') {
            await this.attention(
              connection,
              deploymentId,
              operationId,
              'EXTERNAL_SERVICE_CONFLICT',
              'Service changed during the health stability window',
            );
            return this.deployments.requireWithConnection(
              connection,
              deploymentId,
            );
          }
          if (error.decision === 'FAILED') {
            await this.fail(
              connection,
              deploymentId,
              operationId,
              'CONVERGENCE_FAILED',
              'Swarm update entered a terminal failed state during health verification',
            );
            return this.deployments.requireWithConnection(
              connection,
              deploymentId,
            );
          }
          if (error.decision === 'UNAVAILABLE') {
            lastError = error.message;
          } else {
            lastError = null;
          }
          await sleep(VERIFY_INTERVAL_MS);
          continue;
        }

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

      let finalCurrent: ServiceDetailResponse;
      try {
        finalCurrent = await this.agentClient.inspectService(plan.serviceId);
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const finalDecision = classifyDeploymentSnapshot(
        finalCurrent,
        plan,
        digest,
        noOp,
      );
      if (finalDecision === 'PENDING') {
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }
      if (finalDecision === 'FAILED') {
        await this.fail(
          connection,
          deploymentId,
          operationId,
          'CONVERGENCE_FAILED',
          'Swarm update changed to a terminal failed state before success persistence',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }
      if (finalDecision === 'EXTERNAL_CONFLICT') {
        await this.attention(
          connection,
          deploymentId,
          operationId,
          'EXTERNAL_SERVICE_CONFLICT',
          'Service changed before deployment success could be persisted',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }

      await connection.beginTransaction();
      try {
        await this.operations.markSuccess(
          connection,
          operationId,
          finalCurrent.service.version,
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
          afterJson: finalCurrent.service,
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

    if (lastError) {
      await this.attention(
        connection,
        deploymentId,
        operationId,
        'DEPLOYMENT_VERIFICATION_UNAVAILABLE',
        `Deployment verification timed out after Agent errors: ${lastError}`,
      );
    } else {
      await this.markVerificationPending(
        connection,
        deploymentId,
        operationId,
        'DEPLOYMENT_OBSERVATION_TIMEOUT',
        'Deployment is still converging after the synchronous observation window; mutation protection remains active',
      );
    }
    return this.deployments.requireWithConnection(connection, deploymentId);
  }

  private async reconcileLocked(
    connection: PoolConnection,
    operation: OperationRecord,
    deployment: DeploymentRecord,
    initialError?: string,
  ): Promise<DeploymentRecord> {
    if (
      operation.type !== 'DEPLOY' ||
      !operation.beforeSpecHash ||
      !operation.targetSpecHash ||
      !operation.targetImage ||
      !operation.targetTaskSpecHash
    ) {
      await this.attention(
        connection,
        deployment.id,
        operation.id,
        'DEPLOYMENT_MISSING_TARGET',
        'Deployment intent is missing the persisted target needed for reconciliation',
      );
      return this.deployments.requireWithConnection(
        connection,
        deployment.id,
      );
    }

    const digest = digestFromImage(operation.targetImage);
    if (!digest) {
      await this.attention(
        connection,
        deployment.id,
        operation.id,
        'DEPLOYMENT_INVALID_TARGET_IMAGE',
        'Persisted deployment target image is not digest-pinned',
      );
      return this.deployments.requireWithConnection(
        connection,
        deployment.id,
      );
    }

    const plan: ServiceMutationPlan = {
      serviceId: operation.serviceId,
      version: operation.expectedVersion,
      beforeSpecHash: operation.beforeSpecHash,
      targetSpecHash: operation.targetSpecHash,
      targetForceUpdate: operation.targetForceUpdate,
      targetReplicas: operation.targetReplicas ?? undefined,
      targetImage: operation.targetImage,
      targetTaskSpecHash: operation.targetTaskSpecHash,
    };

    const deadline = Date.now() + RECONCILE_OBSERVATION_MS;
    let lastError = initialError ?? null;
    let observedService = false;
    let rollbackInProgress = false;

    while (Date.now() < deadline) {
      let current: ServiceDetailResponse;
      try {
        current = await this.agentClient.inspectService(operation.serviceId);
        observedService = true;
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const snapshot = classifyDeploymentReconciliationSnapshot(
        operation,
        current,
      );

      if (snapshot === 'ROLLBACK_IN_PROGRESS') {
        rollbackInProgress = true;
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      if (snapshot === 'FAILED') {
        await this.fail(
          connection,
          deployment.id,
          operation.id,
          'CONVERGENCE_FAILED',
          `Swarm update entered ${current.service.updateState}`,
        );
        return this.deployments.requireWithConnection(
          connection,
          deployment.id,
        );
      }

      if (snapshot === 'TARGET_OBSERVED') {
        if (
          operation.status !== 'VERIFYING' ||
          deployment.status !== 'VERIFYING'
        ) {
          await this.markVerifying(
            connection,
            deployment.id,
            operation.id,
            current.service.version,
          );
        }

        return this.verifyAndComplete(
          connection,
          deployment.id,
          operation.id,
          plan,
          digest,
          deployment.noOp,
          deployment.health,
        );
      }

      if (snapshot === 'WAITING_FOR_MUTATION') {
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      await this.attention(
        connection,
        deployment.id,
        operation.id,
        'EXTERNAL_SERVICE_CONFLICT',
        'Service changed outside the recorded deployment target',
      );
      return this.deployments.requireWithConnection(
        connection,
        deployment.id,
      );
    }

    if (rollbackInProgress) {
      await this.markVerificationPending(
        connection,
        deployment.id,
        operation.id,
        'SWARM_ROLLBACK_IN_PROGRESS',
        'Swarm rollback is still in progress; mutation protection remains active',
      );
    } else if (!observedService && lastError) {
      await this.attention(
        connection,
        deployment.id,
        operation.id,
        'DEPLOYMENT_RECONCILIATION_UNAVAILABLE',
        `Unable to inspect deployment outcome: ${lastError}`,
      );
    } else {
      await this.attention(
        connection,
        deployment.id,
        operation.id,
        'DEPLOYMENT_MUTATION_NOT_OBSERVED',
        initialError
          ? `Agent response was lost and the deployment target was not observed: ${initialError}`
          : 'Persisted deployment intent exists but the target service spec was not observed',
      );
    }

    return this.deployments.requireWithConnection(connection, deployment.id);
  }

  private async markVerificationPending(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markVerificationPending(
        connection,
        operationId,
        code,
        message,
      );
      await this.deployments.markVerificationPending(
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
        action: 'DEPLOY_VERIFICATION_PENDING',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async verifyRollbackAndComplete(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    plan: ServiceMutationPlan,
    digest: string,
    health: DeployRequest['health'],
  ): Promise<DeploymentRecord> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      let current: ServiceDetailResponse;
      try {
        current = await this.agentClient.inspectService(plan.serviceId);
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const decision = classifyRollbackSnapshot(current, plan, digest);
      if (decision === 'FAILED') {
        await this.rollbackFailed(
          connection,
          deploymentId,
          operationId,
          'ROLLBACK_FAILED',
          'Swarm rollback entered a terminal failed state',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }
      if (decision === 'EXTERNAL_CONFLICT') {
        await this.rollbackAttention(
          connection,
          deploymentId,
          operationId,
          'ROLLBACK_EXTERNAL_CONFLICT',
          'Service changed outside the recorded rollback target',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }
      if (decision !== 'SUCCESS') {
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      try {
        await this.health.verify(health, async () => {
          let guarded: ServiceDetailResponse;
          try {
            guarded = await this.agentClient.inspectService(plan.serviceId);
          } catch (error) {
            throw new RollbackConvergenceGuardError(
              'UNAVAILABLE',
              errorMessage(error),
            );
          }
          const guardedDecision = classifyRollbackSnapshot(
            guarded,
            plan,
            digest,
          );
          if (guardedDecision !== 'SUCCESS') {
            throw new RollbackConvergenceGuardError(guardedDecision);
          }
        });
      } catch (error) {
        if (error instanceof RollbackConvergenceGuardError) {
          if (error.decision === 'FAILED') {
            await this.rollbackFailed(
              connection,
              deploymentId,
              operationId,
              'ROLLBACK_FAILED',
              'Rollback became unhealthy during recovery verification',
            );
            return this.deployments.requireWithConnection(
              connection,
              deploymentId,
            );
          }
          if (error.decision === 'EXTERNAL_CONFLICT') {
            await this.rollbackAttention(
              connection,
              deploymentId,
              operationId,
              'ROLLBACK_EXTERNAL_CONFLICT',
              'Service changed during rollback recovery health verification',
            );
            return this.deployments.requireWithConnection(
              connection,
              deploymentId,
            );
          }
          lastError =
            error.decision === 'UNAVAILABLE' ? error.message : null;
          await sleep(VERIFY_INTERVAL_MS);
          continue;
        }

        await this.rollbackFailed(
          connection,
          deploymentId,
          operationId,
          'ROLLBACK_HEALTH_FAILED',
          errorMessage(error),
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }

      let finalCurrent: ServiceDetailResponse;
      try {
        finalCurrent = await this.agentClient.inspectService(plan.serviceId);
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const finalDecision = classifyRollbackSnapshot(
        finalCurrent,
        plan,
        digest,
      );
      if (finalDecision === 'PENDING') {
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }
      if (finalDecision === 'FAILED') {
        await this.rollbackFailed(
          connection,
          deploymentId,
          operationId,
          'ROLLBACK_FAILED',
          'Rollback changed to a terminal failed state before persistence',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }
      if (finalDecision === 'EXTERNAL_CONFLICT') {
        await this.rollbackAttention(
          connection,
          deploymentId,
          operationId,
          'ROLLBACK_EXTERNAL_CONFLICT',
          'Service changed before rollback success could be persisted',
        );
        return this.deployments.requireWithConnection(connection, deploymentId);
      }

      await connection.beginTransaction();
      try {
        await this.operations.markSuccess(
          connection,
          operationId,
          finalCurrent.service.version,
        );
        await this.deployments.markRolledBack(connection, deploymentId);
        const operation = await this.operations.findWithConnection(
          connection,
          operationId,
        );
        if (!operation) throw new Error('Rollback operation disappeared');
        await this.operations.audit(connection, {
          operationId,
          actorId: operation.actorId,
          clusterId: operation.clusterId,
          serviceId: operation.serviceId,
          action: 'ROLLBACK_SUCCEEDED',
          afterJson: finalCurrent.service,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }

      return this.deployments.requireWithConnection(connection, deploymentId);
    }

    if (lastError) {
      await this.rollbackAttention(
        connection,
        deploymentId,
        operationId,
        'ROLLBACK_VERIFICATION_UNAVAILABLE',
        `Rollback verification timed out after Agent errors: ${lastError}`,
      );
    } else {
      await this.markRollbackVerificationPending(
        connection,
        deploymentId,
        operationId,
        'ROLLBACK_OBSERVATION_TIMEOUT',
        'Rollback is still converging after the synchronous observation window',
      );
    }
    return this.deployments.requireWithConnection(connection, deploymentId);
  }

  private async reconcileRollbackLocked(
    connection: PoolConnection,
    operation: OperationRecord,
    deployment: DeploymentRecord,
    initialError?: string,
  ): Promise<DeploymentRecord> {
    if (
      operation.type !== 'ROLLBACK' ||
      !operation.beforeSpecHash ||
      !operation.targetSpecHash ||
      !operation.targetImage ||
      !operation.targetTaskSpecHash
    ) {
      await this.rollbackAttention(
        connection,
        deployment.id,
        operation.id,
        'ROLLBACK_MISSING_TARGET',
        'Rollback intent is missing the persisted target needed for reconciliation',
      );
      return this.deployments.requireWithConnection(connection, deployment.id);
    }

    const digest = digestFromImage(operation.targetImage);
    if (!digest) {
      await this.rollbackAttention(
        connection,
        deployment.id,
        operation.id,
        'ROLLBACK_INVALID_TARGET_IMAGE',
        'Persisted rollback image is not digest-pinned',
      );
      return this.deployments.requireWithConnection(connection, deployment.id);
    }

    const plan: ServiceMutationPlan = {
      serviceId: operation.serviceId,
      version: operation.expectedVersion,
      beforeSpecHash: operation.beforeSpecHash,
      targetSpecHash: operation.targetSpecHash,
      targetForceUpdate: operation.targetForceUpdate,
      targetReplicas: operation.targetReplicas ?? undefined,
      targetImage: operation.targetImage,
      targetTaskSpecHash: operation.targetTaskSpecHash,
    };

    const deadline = Date.now() + RECONCILE_OBSERVATION_MS;
    let lastError = initialError ?? null;

    while (Date.now() < deadline) {
      let current: ServiceDetailResponse;
      try {
        current = await this.agentClient.inspectService(operation.serviceId);
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
        await sleep(VERIFY_INTERVAL_MS);
        continue;
      }

      const decision = classifyRollbackSnapshot(current, plan, digest);
      if (decision === 'SUCCESS') {
        if (
          operation.status !== 'VERIFYING' ||
          deployment.status !== 'ROLLBACK_VERIFYING'
        ) {
          await this.markRollbackVerifying(
            connection,
            deployment.id,
            operation.id,
            current.service.version,
          );
        }
        return this.verifyRollbackAndComplete(
          connection,
          deployment.id,
          operation.id,
          plan,
          digest,
          deployment.health,
        );
      }
      if (decision === 'FAILED') {
        await this.rollbackFailed(
          connection,
          deployment.id,
          operation.id,
          'ROLLBACK_FAILED',
          `Swarm rollback entered ${current.service.updateState}`,
        );
        return this.deployments.requireWithConnection(connection, deployment.id);
      }
      if (decision === 'EXTERNAL_CONFLICT') {
        await this.rollbackAttention(
          connection,
          deployment.id,
          operation.id,
          'ROLLBACK_EXTERNAL_CONFLICT',
          'Service changed outside the recorded rollback target',
        );
        return this.deployments.requireWithConnection(connection, deployment.id);
      }

      await sleep(VERIFY_INTERVAL_MS);
    }

    if (lastError) {
      await this.rollbackAttention(
        connection,
        deployment.id,
        operation.id,
        'ROLLBACK_RECONCILIATION_UNAVAILABLE',
        `Unable to inspect rollback outcome: ${lastError}`,
      );
    } else {
      await this.markRollbackVerificationPending(
        connection,
        deployment.id,
        operation.id,
        'ROLLBACK_STILL_IN_PROGRESS',
        initialError
          ? `Rollback response was lost and convergence is still in progress: ${initialError}`
          : 'Rollback is still in progress',
      );
    }
    return this.deployments.requireWithConnection(connection, deployment.id);
  }

  private async markRollbackVerificationPending(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markVerificationPending(
        connection,
        operationId,
        code,
        message,
      );
      await this.deployments.markRollbackVerificationPending(
        connection,
        deploymentId,
        message,
      );
      const operation = await this.operations.findWithConnection(
        connection,
        operationId,
      );
      if (!operation) throw new Error('Rollback operation disappeared');
      await this.operations.audit(connection, {
        operationId,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'ROLLBACK_VERIFICATION_PENDING',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async rollbackFailed(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markNeedsAttention(
        connection,
        operationId,
        code,
        message,
      );
      await this.deployments.markRollbackFailed(
        connection,
        deploymentId,
        message,
      );
      const operation = await this.operations.findWithConnection(
        connection,
        operationId,
      );
      if (!operation) throw new Error('Rollback operation disappeared');
      await this.operations.audit(connection, {
        operationId,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'ROLLBACK_FAILED',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async rollbackAttention(
    connection: PoolConnection,
    deploymentId: string,
    operationId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markNeedsAttention(
        connection,
        operationId,
        code,
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
      if (!operation) throw new Error('Rollback operation disappeared');
      await this.operations.audit(connection, {
        operationId,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'ROLLBACK_NEEDS_ATTENTION',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
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
    code: string,
    message: string,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markNeedsAttention(
        connection,
        operationId,
        code,
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
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async requireOperation(
    connection: PoolConnection,
    operationId: string,
  ): Promise<OperationRecord> {
    const operation = await this.operations.findWithConnection(
      connection,
      operationId,
    );
    if (!operation) {
      throw new Error('Deployment operation disappeared after persistence');
    }
    return operation;
  }

  private buildObservedRollbackPlan(
    deployment: DeploymentRecord,
    previousDigest: string,
    current: ServiceDetailResponse,
  ): ServiceImageMutationPlan {
    const rollbackSpecHash = readSpecHash(deployment.beforeSpec);
    const failedSpecHash = readSpecHash(deployment.targetSpec);
    if (
      !rollbackSpecHash ||
      !failedSpecHash ||
      current.service.specHash !== rollbackSpecHash ||
      digestFromImage(current.service.image ?? '') !== previousDigest.toLowerCase() ||
      !current.service.taskSpecHash
    ) {
      throw new ConflictException(
        'Observed Swarm rollback target does not match the recorded previous deployment spec',
      );
    }

    return {
      serviceId: current.service.id,
      version: current.service.version,
      beforeSpecHash: failedSpecHash,
      targetSpecHash: rollbackSpecHash,
      targetForceUpdate: current.service.forceUpdate,
      targetReplicas: current.service.desiredReplicas,
      targetImage: current.service.image ?? '',
      targetTaskSpecHash: current.service.taskSpecHash,
    };
  }

  private assertRollbackOwnership(
    deployment: DeploymentRecord,
    previousDigest: string,
    plan: ServiceImageMutationPlan,
    current: ServiceDetailResponse,
  ): void {
    const previousSpecHash = readSpecHash(deployment.beforeSpec);
    if (
      !previousSpecHash ||
      plan.targetSpecHash !== previousSpecHash ||
      plan.beforeSpecHash !== current.service.specHash ||
      digestFromImage(plan.targetImage) !== previousDigest.toLowerCase() ||
      !plan.targetTaskSpecHash
    ) {
      throw new ConflictException(
        'Swarm previous spec does not match the recorded deployment rollback target',
      );
    }
  }

  private assertRollbackIdempotent(
    operation: OperationRecord,
    actorId: string,
    serviceId: string,
  ): void {
    if (
      operation.type !== 'ROLLBACK' ||
      operation.actorId !== actorId ||
      operation.serviceId !== serviceId
    ) {
      throw new ConflictException(
        'operationId was already used for a different mutation',
      );
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

class DeploymentConvergenceGuardError extends Error {
  constructor(
    readonly decision: DeploymentDecision | 'UNAVAILABLE',
    message = 'Deployment convergence changed during health verification',
  ) {
    super(message);
    this.name = 'DeploymentConvergenceGuardError';
  }
}

export type DeploymentReconciliationDecision =
  | 'TARGET_OBSERVED'
  | 'WAITING_FOR_MUTATION'
  | 'ROLLBACK_IN_PROGRESS'
  | 'FAILED'
  | 'EXTERNAL_CONFLICT';

export function classifyDeploymentReconciliationSnapshot(
  operation: OperationRecord,
  current: ServiceDetailResponse,
): DeploymentReconciliationDecision {
  const updateState = current.service.updateState;
  if (updateState === 'rollback_started') {
    return 'ROLLBACK_IN_PROGRESS';
  }
  if (updateState === 'paused' || updateState === 'rollback_completed') {
    return 'FAILED';
  }

  if (current.service.specHash === operation.targetSpecHash) {
    return 'TARGET_OBSERVED';
  }

  if (
    current.service.version < operation.expectedVersion ||
    (
      current.service.version === operation.expectedVersion &&
      current.service.specHash === operation.beforeSpecHash
    )
  ) {
    return 'WAITING_FOR_MUTATION';
  }

  return 'EXTERNAL_CONFLICT';
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
  if (updateState === 'rollback_started') return 'PENDING';
  if (updateState === 'paused' || updateState === 'rollback_completed') {
    return 'FAILED';
  }

  if (!noOp && updateState !== 'completed') return 'PENDING';
  if (current.service.desiredReplicas !== current.service.runningReplicas) {
    return 'PENDING';
  }

  if (!plan.targetTaskSpecHash) return 'PENDING';

  const running = current.tasks.filter(
    (task) =>
      task.state === 'running' &&
      task.desiredState === 'running',
  );
  const slots = new Set(running.map((task) => task.slot));
  if (
    running.length !== current.service.desiredReplicas ||
    slots.size !== current.service.desiredReplicas ||
    !running.every(
      (task) =>
        task.slot > 0 &&
        imageContainsDigest(task.image, digest) &&
        task.forceUpdate === plan.targetForceUpdate &&
        task.specHash === plan.targetTaskSpecHash,
    )
  ) {
    return 'PENDING';
  }
  return 'SUCCESS';
}

export function classifyRollbackSnapshot(
  current: ServiceDetailResponse,
  plan: ServiceMutationPlan,
  digest: string,
): DeploymentDecision {
  if (current.service.specHash !== plan.targetSpecHash) {
    if (current.service.updateState === 'rollback_started') return 'PENDING';
    if (current.service.version > plan.version) return 'EXTERNAL_CONFLICT';
    return 'PENDING';
  }

  if (!imageContainsDigest(current.service.image, digest)) return 'PENDING';
  if (current.service.updateState === 'paused') return 'FAILED';
  if (current.service.updateState === 'rollback_started') return 'PENDING';

  if (!plan.targetTaskSpecHash) return 'PENDING';
  if (current.service.desiredReplicas !== current.service.runningReplicas) {
    return 'PENDING';
  }

  const running = current.tasks.filter(
    (task) =>
      task.state === 'running' &&
      task.desiredState === 'running',
  );
  const slots = new Set(running.map((task) => task.slot));
  if (
    running.length !== current.service.desiredReplicas ||
    slots.size !== current.service.desiredReplicas ||
    !running.every(
      (task) =>
        task.slot > 0 &&
        imageContainsDigest(task.image, digest) &&
        task.forceUpdate === plan.targetForceUpdate &&
        task.specHash === plan.targetTaskSpecHash,
    )
  ) {
    return 'PENDING';
  }

  return 'SUCCESS';
}

class RollbackConvergenceGuardError extends Error {
  constructor(
    readonly decision: DeploymentDecision | 'UNAVAILABLE',
    message = 'Rollback convergence changed during recovery health verification',
  ) {
    super(message);
    this.name = 'RollbackConvergenceGuardError';
  }
}

function readSpecHash(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    'specHash' in value &&
    typeof value.specHash === 'string' &&
    value.specHash.length > 0
  ) {
    return value.specHash;
  }
  return null;
}

export function dockerImageReference(repository: string, digest: string): string {
  const withoutScheme = repository.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `${withoutScheme}@${digest.toLowerCase()}`;
}

function digestFromImage(image: string): string | null {
  const match = image.match(/@(sha256:[A-Fa-f0-9]{64})$/);
  return match?.[1]?.toLowerCase() ?? null;
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
  plan: ServiceImageMutationPlan,
  current: ServiceDetailResponse,
  targetImage: string,
): void {
  if (
    plan.serviceId !== current.service.id ||
    plan.version !== current.service.version ||
    plan.beforeSpecHash !== current.service.specHash ||
    plan.targetImage !== targetImage ||
    !plan.targetTaskSpecHash
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


function sameHealthConfig(
  left: DeployRequest['health'],
  right: DeployRequest['health'],
): boolean {
  return (
    left.url === right.url &&
    left.intervalMs === right.intervalMs &&
    left.timeoutMs === right.timeoutMs &&
    left.retries === right.retries &&
    left.stabilityWindowMs === right.stabilityWindowMs &&
    left.expectedStatus === right.expectedStatus
  );
}
