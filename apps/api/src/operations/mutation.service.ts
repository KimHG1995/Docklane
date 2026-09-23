import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
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
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import { NodeOperationRepository } from './node-operation.repository.js';
import type { OperationRecord, OperationType } from './operation.types.js';
import type {
  RestartServiceRequest,
  ScaleServiceRequest,
} from './mutation.dto.js';
import { classifyMutationSnapshot } from './mutation-verification.js';

const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 500;

type VerificationResult =
  | { status: 'SUCCESS'; current: ServiceDetailResponse }
  | { status: 'FAILED'; current: ServiceDetailResponse; message: string }
  | {
      status: 'EXTERNAL_CONFLICT';
      current: ServiceDetailResponse;
      message: string;
    }
  | {
      status: 'UNCERTAIN';
      current: ServiceDetailResponse | null;
      message: string;
    };

@Injectable()
export class MutationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MutationService.name);
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
    @Inject(OperationRepository)
    private readonly operations: OperationRepository,
    @Inject(NodeOperationRepository)
    private readonly nodeOperations: NodeOperationRepository,
    @Inject(OperationLock) private readonly lock: OperationLock,
    @Inject(CapacityService) private readonly capacity: CapacityService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pending = await this.operations.listNonTerminal();

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
            if (!current || isTerminal(current)) {
              return;
            }
            await this.reconcileLocked(connection, current);
          },
        );
      } catch (error) {
        this.logger.error(
          `Failed to reconcile operation ${operation.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async operation(
    clusterId: string,
    operationId: string,
  ): Promise<OperationRecord> {
    this.assertCluster(clusterId);
    const operation = await this.operations.find(operationId);
    if (!operation || operation.clusterId !== clusterId) {
      throw new NotFoundException('Operation not found');
    }
    return operation;
  }

  async scale(
    clusterId: string,
    requestedServiceId: string,
    input: ScaleServiceRequest,
    principal: Principal,
  ): Promise<OperationRecord> {
    this.assertCluster(clusterId);

    const resolved = await this.agentClient.inspectService(requestedServiceId);
    const canonicalServiceId = resolved.service.id;

    return this.lock.withServiceLock(
      clusterId,
      canonicalServiceId,
      async (connection) => {
        const existing = await this.operations.findWithConnection(
          connection,
          input.operationId,
        );
        if (existing) {
          this.assertIdempotent(existing, {
            type: 'SCALE',
            clusterId,
            serviceId: canonicalServiceId,
            actorId: principal.actorId,
            expectedVersion: input.expectedVersion,
            targetReplicas: input.replicas,
          });
          return isTerminal(existing)
            ? existing
            : this.reconcileLocked(connection, existing);
        }

        await this.resolvePriorServiceOperation(
          connection,
          clusterId,
          canonicalServiceId,
        );

        await this.assertNoNodeOperationConflict(
          connection,
          clusterId,
          canonicalServiceId,
        );

        let plan: ServiceMutationPlan;
        try {
          plan = await this.agentClient.planScaleService(
            canonicalServiceId,
            input.expectedVersion,
            input.replicas,
          );
        } catch (error) {
          throw mapPlanningError(error);
        }
        const before = await this.agentClient.inspectService(canonicalServiceId);
        this.assertPlanMatchesCurrent(plan, before);

        await this.capacity.assertAvailable(canonicalServiceId, {
          expectedVersion: plan.version,
          targetReplicas: input.replicas,
          includeUpdateOverlap: false,
        });

        await this.persistIntent(connection, {
          operationId: input.operationId,
          clusterId,
          plan,
          type: 'SCALE',
          actorId: principal.actorId,
          targetReplicas: input.replicas,
          before,
        });

        try {
          const accepted = await this.agentClient.scaleService(
            canonicalServiceId,
            {
              expectedVersion: plan.version,
              expectedSpecHash: plan.beforeSpecHash,
              targetSpecHash: plan.targetSpecHash,
              replicas: input.replicas,
            },
          );
          this.assertAcceptedMatchesPlan(accepted, plan);
          await this.markVerifying(connection, input.operationId, accepted);
        } catch (error) {
          if (isDeterministicAgentRejection(error)) {
            await this.markAgentRejected(
              connection,
              input.operationId,
              principal.actorId,
              clusterId,
              canonicalServiceId,
              error,
            );
            throw mapAgentError(error);
          }

          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.reconcileLocked(connection, operation);
        }

        const operation = await this.requireOperation(
          connection,
          input.operationId,
        );
        return this.verifyAndCompleteLocked(connection, operation);
      },
    );
  }

  async restart(
    clusterId: string,
    requestedServiceId: string,
    input: RestartServiceRequest,
    principal: Principal,
  ): Promise<OperationRecord> {
    this.assertCluster(clusterId);

    const resolved = await this.agentClient.inspectService(requestedServiceId);
    const canonicalServiceId = resolved.service.id;

    return this.lock.withServiceLock(
      clusterId,
      canonicalServiceId,
      async (connection) => {
        const existing = await this.operations.findWithConnection(
          connection,
          input.operationId,
        );
        if (existing) {
          this.assertIdempotent(existing, {
            type: 'RESTART',
            clusterId,
            serviceId: canonicalServiceId,
            actorId: principal.actorId,
            expectedVersion: input.expectedVersion,
            targetReplicas: null,
          });
          return isTerminal(existing)
            ? existing
            : this.reconcileLocked(connection, existing);
        }

        await this.resolvePriorServiceOperation(
          connection,
          clusterId,
          canonicalServiceId,
        );

        await this.assertNoNodeOperationConflict(
          connection,
          clusterId,
          canonicalServiceId,
        );

        let plan: ServiceMutationPlan;
        try {
          plan = await this.agentClient.planRestartService(
            canonicalServiceId,
            input.expectedVersion,
          );
        } catch (error) {
          throw mapPlanningError(error);
        }
        const before = await this.agentClient.inspectService(canonicalServiceId);
        this.assertPlanMatchesCurrent(plan, before);

        await this.capacity.assertAvailable(canonicalServiceId, {
          expectedVersion: plan.version,
          targetReplicas: before.service.desiredReplicas,
          includeUpdateOverlap: true,
        });

        await this.persistIntent(connection, {
          operationId: input.operationId,
          clusterId,
          plan,
          type: 'RESTART',
          actorId: principal.actorId,
          before,
        });

        try {
          const accepted = await this.agentClient.restartService(
            canonicalServiceId,
            {
              expectedVersion: plan.version,
              expectedSpecHash: plan.beforeSpecHash,
              targetSpecHash: plan.targetSpecHash,
            },
          );
          this.assertAcceptedMatchesPlan(accepted, plan);
          await this.markVerifying(connection, input.operationId, accepted);
        } catch (error) {
          if (isDeterministicAgentRejection(error)) {
            await this.markAgentRejected(
              connection,
              input.operationId,
              principal.actorId,
              clusterId,
              canonicalServiceId,
              error,
            );
            throw mapAgentError(error);
          }

          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.reconcileLocked(connection, operation);
        }

        const operation = await this.requireOperation(
          connection,
          input.operationId,
        );
        return this.verifyAndCompleteLocked(connection, operation);
      },
    );
  }

  private async assertNoNodeOperationConflict(
    connection: PoolConnection,
    clusterId: string,
    serviceId: string,
  ): Promise<void> {
    const nodeOperation =
      await this.nodeOperations.findNonTerminalAffectingServiceWithConnection(
        connection,
        clusterId,
        serviceId,
      );

    if (nodeOperation) {
      throw new ConflictException(
        `Service is affected by unresolved node operation ${nodeOperation.id} (${nodeOperation.status})`,
      );
    }
  }

  private async resolvePriorServiceOperation(
    connection: PoolConnection,
    clusterId: string,
    serviceId: string,
  ): Promise<void> {
    const prior =
      await this.operations.findNonTerminalForServiceWithConnection(
        connection,
        clusterId,
        serviceId,
      );
    if (!prior) {
      return;
    }

    const reconciled = await this.reconcileLocked(connection, prior);
    if (!isTerminal(reconciled)) {
      throw new ConflictException(
        `Service has unresolved operation ${reconciled.id} (${reconciled.status})`,
      );
    }
  }

  private async reconcileLocked(
    connection: PoolConnection,
    operation: OperationRecord,
  ): Promise<OperationRecord> {
    if (
      !operation.beforeSpecHash ||
      !operation.targetSpecHash
    ) {
      await this.markNeedsAttention(
        connection,
        operation,
        'LEGACY_OPERATION_MISSING_TARGET',
        'Operation predates service fingerprint tracking and cannot be reconciled automatically',
      );
      return this.requireOperation(connection, operation.id);
    }
    let current: ServiceDetailResponse;

    try {
      current = await this.agentClient.inspectService(operation.serviceId);
    } catch (error) {
      await this.markNeedsAttention(
        connection,
        operation,
        'RECONCILIATION_UNAVAILABLE',
        `Unable to inspect service during reconciliation: ${errorMessage(error)}`,
      );
      return this.requireOperation(connection, operation.id);
    }

    if (current.service.specHash === operation.targetSpecHash) {
      if (operation.status !== 'VERIFYING') {
        await this.markVerifying(connection, operation.id, {
          serviceId: operation.serviceId,
          version: current.service.version,
          targetSpecHash: operation.targetSpecHash,
          targetForceUpdate: operation.targetForceUpdate,
        });
        await this.audit(connection, operation, 'MUTATION_RECONCILED', {
          version: current.service.version,
          specHash: current.service.specHash,
        });
      }

      const refreshed = await this.requireOperation(connection, operation.id);
      return this.verifyAndCompleteLocked(connection, refreshed);
    }

    if (
      current.service.version === operation.expectedVersion &&
      current.service.specHash === operation.beforeSpecHash
    ) {
      await this.markNeedsAttention(
        connection,
        operation,
        'MUTATION_NOT_OBSERVED',
        'Mutation outcome is uncertain and the target spec was not observed',
      );
      return this.requireOperation(connection, operation.id);
    }

    await this.markNeedsAttention(
      connection,
      operation,
      'EXTERNAL_SERVICE_CONFLICT',
      'Service spec changed outside the recorded Docklane mutation',
      current.service,
    );
    return this.requireOperation(connection, operation.id);
  }

  private async verifyAndCompleteLocked(
    connection: PoolConnection,
    operation: OperationRecord,
  ): Promise<OperationRecord> {
    const verification = await this.verify(operation);

    await connection.beginTransaction();
    try {
      if (verification.status === 'SUCCESS') {
        await this.operations.markSuccess(
          connection,
          operation.id,
          verification.current.service.version,
        );
        await this.operations.audit(connection, {
          operationId: operation.id,
          actorId: operation.actorId,
          clusterId: operation.clusterId,
          serviceId: operation.serviceId,
          action: 'MUTATION_SUCCEEDED',
          afterJson: verification.current.service,
        });
      } else if (verification.status === 'FAILED') {
        await this.operations.markFailed(
          connection,
          operation.id,
          'CONVERGENCE_FAILED',
          verification.message,
        );
        await this.operations.audit(connection, {
          operationId: operation.id,
          actorId: operation.actorId,
          clusterId: operation.clusterId,
          serviceId: operation.serviceId,
          action: 'MUTATION_CONVERGENCE_FAILED',
          afterJson: verification.current.service,
        });
      } else {
        const code =
          verification.status === 'EXTERNAL_CONFLICT'
            ? 'EXTERNAL_SERVICE_CONFLICT'
            : 'VERIFICATION_UNCERTAIN';
        await this.operations.markNeedsAttention(
          connection,
          operation.id,
          code,
          verification.message,
        );
        await this.operations.audit(connection, {
          operationId: operation.id,
          actorId: operation.actorId,
          clusterId: operation.clusterId,
          serviceId: operation.serviceId,
          action: 'MUTATION_NEEDS_ATTENTION',
          afterJson: verification.current?.service,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    return this.requireOperation(connection, operation.id);
  }

  private async verify(operation: OperationRecord): Promise<VerificationResult> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last: ServiceDetailResponse | null = null;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      try {
        const current = await this.agentClient.inspectService(
          operation.serviceId,
        );
        last = current;
        lastError = null;

        const decision = classifyMutationSnapshot(operation, current);
        if (decision.status === 'EXTERNAL_CONFLICT') {
          return {
            status: 'EXTERNAL_CONFLICT',
            current,
            message: decision.message,
          };
        }
        if (decision.status === 'FAILED') {
          return {
            status: 'FAILED',
            current,
            message: decision.message,
          };
        }
        if (decision.status === 'SUCCESS') {
          return { status: 'SUCCESS', current };
        }
      } catch (error) {
        lastError = errorMessage(error);
      }

      await sleep(VERIFY_INTERVAL_MS);
    }

    return {
      status: 'UNCERTAIN',
      current: last,
      message: lastError
        ? `Verification timed out after Agent errors: ${lastError}`
        : 'Service mutation was accepted but convergence was not confirmed',
    };
  }

  private async persistIntent(
    connection: PoolConnection,
    input: {
      operationId: string;
      clusterId: string;
      plan: ServiceMutationPlan;
      type: OperationType;
      actorId: string;
      targetReplicas?: number;
      before: ServiceDetailResponse;
    },
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.create(connection, {
        id: input.operationId,
        clusterId: input.clusterId,
        serviceId: input.plan.serviceId,
        type: input.type,
        actorId: input.actorId,
        expectedVersion: input.plan.version,
        beforeSpecHash: input.plan.beforeSpecHash,
        targetSpecHash: input.plan.targetSpecHash,
        targetForceUpdate: input.plan.targetForceUpdate,
        targetReplicas: input.targetReplicas,
      });
      await this.operations.markRunning(connection, input.operationId);
      await this.operations.audit(connection, {
        operationId: input.operationId,
        actorId: input.actorId,
        clusterId: input.clusterId,
        serviceId: input.plan.serviceId,
        action: `${input.type}_STARTED`,
        beforeJson: input.before.service,
        afterJson: {
          targetSpecHash: input.plan.targetSpecHash,
          targetForceUpdate: input.plan.targetForceUpdate,
          targetReplicas: input.targetReplicas,
        },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async markVerifying(
    connection: PoolConnection,
    operationId: string,
    accepted: ServiceMutationResponse,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markVerifying(
        connection,
        operationId,
        accepted.version,
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async markAgentRejected(
    connection: PoolConnection,
    operationId: string,
    actorId: string,
    clusterId: string,
    serviceId: string,
    error: AgentRequestError,
  ): Promise<void> {
    const code =
      error.statusCode === 409
        ? 'AGENT_VERSION_CONFLICT'
        : 'AGENT_MUTATION_REJECTED';

    await connection.beginTransaction();
    try {
      await this.operations.markFailed(
        connection,
        operationId,
        code,
        error.responseBody,
      );
      await this.operations.audit(connection, {
        operationId,
        actorId,
        clusterId,
        serviceId,
        action: 'MUTATION_REJECTED',
        afterJson: {
          statusCode: error.statusCode,
          body: error.responseBody,
        },
      });
      await connection.commit();
    } catch (persistError) {
      await connection.rollback();
      throw persistError;
    }
  }

  private async markNeedsAttention(
    connection: PoolConnection,
    operation: OperationRecord,
    code: string,
    message: string,
    current?: unknown,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markNeedsAttention(
        connection,
        operation.id,
        code,
        message,
      );
      await this.operations.audit(connection, {
        operationId: operation.id,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action: 'MUTATION_NEEDS_ATTENTION',
        afterJson: current ?? { code, message },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async audit(
    connection: PoolConnection,
    operation: OperationRecord,
    action: string,
    afterJson?: unknown,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.audit(connection, {
        operationId: operation.id,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.serviceId,
        action,
        afterJson,
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
      throw new Error('Operation disappeared after persistence');
    }
    return operation;
  }

  private assertPlanMatchesCurrent(
    plan: ServiceMutationPlan,
    current: ServiceDetailResponse,
  ): void {
    if (
      current.service.id !== plan.serviceId ||
      current.service.version !== plan.version ||
      current.service.specHash !== plan.beforeSpecHash
    ) {
      throw new ConflictException(
        'Service changed between resolution and mutation planning',
      );
    }
  }

  private assertAcceptedMatchesPlan(
    accepted: ServiceMutationResponse,
    plan: ServiceMutationPlan,
  ): void {
    if (
      accepted.serviceId !== plan.serviceId ||
      accepted.targetSpecHash !== plan.targetSpecHash ||
      accepted.targetForceUpdate !== plan.targetForceUpdate
    ) {
      throw new ConflictException(
        'Agent mutation response does not match the recorded target',
      );
    }
  }

  private assertIdempotent(
    existing: OperationRecord,
    expected: {
      type: OperationType;
      clusterId: string;
      serviceId: string;
      actorId: string;
      expectedVersion: number;
      targetReplicas: number | null;
    },
  ): void {
    if (
      existing.type !== expected.type ||
      existing.clusterId !== expected.clusterId ||
      existing.serviceId !== expected.serviceId ||
      existing.actorId !== expected.actorId ||
      existing.expectedVersion !== expected.expectedVersion ||
      existing.targetReplicas !== expected.targetReplicas
    ) {
      throw new ConflictException(
        'operationId was already used for a different mutation',
      );
    }
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
  }
}

function isTerminal(operation: OperationRecord): boolean {
  return operation.status === 'SUCCESS' || operation.status === 'FAILED';
}

function isDeterministicAgentRejection(
  error: unknown,
): error is AgentRequestError {
  return (
    error instanceof AgentRequestError &&
    (error.statusCode === 400 || error.statusCode === 409)
  );
}

function mapAgentError(error: AgentRequestError): Error {
  if (error.statusCode === 409) {
    return new ConflictException('Agent rejected stale service state');
  }
  if (error.statusCode === 400) {
    return new BadGatewayException('Agent rejected mutation request');
  }
  return new BadGatewayException('Agent mutation failed');
}

function mapPlanningError(error: unknown): Error {
  if (error instanceof AgentRequestError) {
    if (error.statusCode === 409) {
      return new ConflictException('Service changed before mutation planning');
    }
    if (error.statusCode === 400) {
      return new BadGatewayException('Agent rejected mutation planning');
    }
    return new BadGatewayException('Agent mutation planning failed');
  }
  return error instanceof Error
    ? error
    : new BadGatewayException('Agent mutation planning failed');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
