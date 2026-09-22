import {
  BadGatewayException,
  ConflictException,
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
  ServiceMutationResponse,
} from '../agent/read-model.js';
import type { Principal } from '../auth/auth.types.js';
import { Inject } from '@nestjs/common';
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import type { OperationRecord, OperationType } from './operation.types.js';
import type {
  RestartServiceRequest,
  ScaleServiceRequest,
} from './mutation.dto.js';

const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 500;

@Injectable()
export class MutationService {
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
    private readonly operations: OperationRepository,
    private readonly lock: OperationLock,
  ) {}

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
    serviceId: string,
    input: ScaleServiceRequest,
    principal: Principal,
  ): Promise<OperationRecord> {
    this.assertCluster(clusterId);

    return this.lock.withServiceLock(clusterId, serviceId, async (connection) => {
      const existing = await this.operations.find(input.operationId);
      if (existing) {
        this.assertIdempotent(existing, {
          type: 'SCALE',
          clusterId,
          serviceId,
          actorId: principal.actorId,
          expectedVersion: input.expectedVersion,
          targetReplicas: input.replicas,
        });
        return existing;
      }

      const before = await this.agentClient.inspectService(serviceId);
      await this.persistIntent(connection, {
        operationId: input.operationId,
        clusterId,
        serviceId,
        type: 'SCALE',
        actorId: principal.actorId,
        expectedVersion: input.expectedVersion,
        targetReplicas: input.replicas,
        before,
      });

      if (before.service.version !== input.expectedVersion) {
        await this.failPrecondition(
          connection,
          input.operationId,
          principal,
          clusterId,
          serviceId,
          before,
          input.expectedVersion,
        );
        throw new ConflictException(
          `Service version conflict: expected ${input.expectedVersion}, got ${before.service.version}`,
        );
      }

      let accepted: ServiceMutationResponse;
      try {
        accepted = await this.agentClient.scaleService(
          before.service.id,
          input.expectedVersion,
          input.replicas,
        );
      } catch (error) {
        await this.failAgentMutation(
          connection,
          input.operationId,
          principal,
          clusterId,
          serviceId,
          error,
        );
        throw mapAgentError(error);
      }

      await this.markVerifying(
        connection,
        input.operationId,
        principal,
        clusterId,
        serviceId,
        accepted,
      );

      const verification = await this.verify(
        before.service.id,
        accepted.version,
        (current) =>
          current.service.desiredReplicas === input.replicas &&
          current.service.runningReplicas === input.replicas,
      );

      return this.completeVerification(
        connection,
        input.operationId,
        principal,
        clusterId,
        serviceId,
        accepted.version,
        verification,
      );
    });
  }

  async restart(
    clusterId: string,
    serviceId: string,
    input: RestartServiceRequest,
    principal: Principal,
  ): Promise<OperationRecord> {
    this.assertCluster(clusterId);

    return this.lock.withServiceLock(clusterId, serviceId, async (connection) => {
      const existing = await this.operations.find(input.operationId);
      if (existing) {
        this.assertIdempotent(existing, {
          type: 'RESTART',
          clusterId,
          serviceId,
          actorId: principal.actorId,
          expectedVersion: input.expectedVersion,
          targetReplicas: null,
        });
        return existing;
      }

      const before = await this.agentClient.inspectService(serviceId);
      await this.persistIntent(connection, {
        operationId: input.operationId,
        clusterId,
        serviceId,
        type: 'RESTART',
        actorId: principal.actorId,
        expectedVersion: input.expectedVersion,
        before,
      });

      if (before.service.version !== input.expectedVersion) {
        await this.failPrecondition(
          connection,
          input.operationId,
          principal,
          clusterId,
          serviceId,
          before,
          input.expectedVersion,
        );
        throw new ConflictException(
          `Service version conflict: expected ${input.expectedVersion}, got ${before.service.version}`,
        );
      }

      let accepted: ServiceMutationResponse;
      try {
        accepted = await this.agentClient.restartService(
          before.service.id,
          input.expectedVersion,
        );
      } catch (error) {
        await this.failAgentMutation(
          connection,
          input.operationId,
          principal,
          clusterId,
          serviceId,
          error,
        );
        throw mapAgentError(error);
      }

      await this.markVerifying(
        connection,
        input.operationId,
        principal,
        clusterId,
        serviceId,
        accepted,
      );

      const verification = await this.verify(
        before.service.id,
        accepted.version,
        (current) =>
          current.service.desiredReplicas === current.service.runningReplicas &&
          current.service.updateState === 'completed',
      );

      return this.completeVerification(
        connection,
        input.operationId,
        principal,
        clusterId,
        serviceId,
        accepted.version,
        verification,
      );
    });
  }

  private async persistIntent(
    connection: PoolConnection,
    input: {
      operationId: string;
      clusterId: string;
      serviceId: string;
      type: OperationType;
      actorId: string;
      expectedVersion: number;
      targetReplicas?: number;
      before: ServiceDetailResponse;
    },
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.create(connection, {
        id: input.operationId,
        clusterId: input.clusterId,
        serviceId: input.serviceId,
        type: input.type,
        actorId: input.actorId,
        expectedVersion: input.expectedVersion,
        targetReplicas: input.targetReplicas,
      });
      await this.operations.markRunning(connection, input.operationId);
      await this.operations.audit(connection, {
        operationId: input.operationId,
        actorId: input.actorId,
        clusterId: input.clusterId,
        serviceId: input.serviceId,
        action: `${input.type}_STARTED`,
        beforeJson: input.before.service,
        afterJson:
          input.targetReplicas === undefined
            ? undefined
            : { replicas: input.targetReplicas },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async failPrecondition(
    connection: PoolConnection,
    operationId: string,
    principal: Principal,
    clusterId: string,
    serviceId: string,
    before: ServiceDetailResponse,
    expectedVersion: number,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markFailed(
        connection,
        operationId,
        'VERSION_CONFLICT',
        `Expected ${expectedVersion}, got ${before.service.version}`,
      );
      await this.operations.audit(connection, {
        operationId,
        actorId: principal.actorId,
        clusterId,
        serviceId,
        action: 'MUTATION_REJECTED',
        beforeJson: before.service,
        afterJson: { expectedVersion },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async failAgentMutation(
    connection: PoolConnection,
    operationId: string,
    principal: Principal,
    clusterId: string,
    serviceId: string,
    error: unknown,
  ): Promise<void> {
    const code =
      error instanceof AgentRequestError && error.statusCode === 409
        ? 'AGENT_VERSION_CONFLICT'
        : 'AGENT_MUTATION_FAILED';
    const message =
      error instanceof AgentRequestError
        ? error.responseBody
        : error instanceof Error
          ? error.message
          : String(error);

    await connection.beginTransaction();
    try {
      await this.operations.markFailed(connection, operationId, code, message);
      await this.operations.audit(connection, {
        operationId,
        actorId: principal.actorId,
        clusterId,
        serviceId,
        action: 'MUTATION_FAILED',
        afterJson: { code, message },
      });
      await connection.commit();
    } catch (persistError) {
      await connection.rollback();
      throw persistError;
    }
  }

  private async markVerifying(
    connection: PoolConnection,
    operationId: string,
    principal: Principal,
    clusterId: string,
    serviceId: string,
    accepted: ServiceMutationResponse,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.operations.markVerifying(
        connection,
        operationId,
        accepted.version,
      );
      await this.operations.audit(connection, {
        operationId,
        actorId: principal.actorId,
        clusterId,
        serviceId,
        action: 'MUTATION_ACCEPTED',
        afterJson: accepted,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async verify(
    serviceId: string,
    resultVersion: number,
    predicate: (current: ServiceDetailResponse) => boolean,
  ): Promise<
    | { status: 'SUCCESS'; current: ServiceDetailResponse }
    | { status: 'FAILED'; current: ServiceDetailResponse; message: string }
    | { status: 'TIMEOUT'; current: ServiceDetailResponse | null }
  > {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last: ServiceDetailResponse | null = null;

    while (Date.now() < deadline) {
      const current = await this.agentClient.inspectService(serviceId);
      last = current;

      if (current.service.version >= resultVersion) {
        const state = current.service.updateState;
        if (
          state === 'paused' ||
          state === 'rollback_started' ||
          state === 'rollback_completed'
        ) {
          return {
            status: 'FAILED',
            current,
            message: `Unexpected update state: ${state}`,
          };
        }

        if (predicate(current)) {
          return { status: 'SUCCESS', current };
        }
      }

      await sleep(VERIFY_INTERVAL_MS);
    }

    return { status: 'TIMEOUT', current: last };
  }

  private async completeVerification(
    connection: PoolConnection,
    operationId: string,
    principal: Principal,
    clusterId: string,
    serviceId: string,
    resultVersion: number,
    verification:
      | { status: 'SUCCESS'; current: ServiceDetailResponse }
      | { status: 'FAILED'; current: ServiceDetailResponse; message: string }
      | { status: 'TIMEOUT'; current: ServiceDetailResponse | null },
  ): Promise<OperationRecord> {
    await connection.beginTransaction();
    try {
      if (verification.status === 'SUCCESS') {
        await this.operations.markSuccess(
          connection,
          operationId,
          resultVersion,
        );
        await this.operations.audit(connection, {
          operationId,
          actorId: principal.actorId,
          clusterId,
          serviceId,
          action: 'MUTATION_SUCCEEDED',
          afterJson: verification.current.service,
        });
      } else if (verification.status === 'FAILED') {
        await this.operations.markFailed(
          connection,
          operationId,
          'CONVERGENCE_FAILED',
          verification.message,
        );
        await this.operations.audit(connection, {
          operationId,
          actorId: principal.actorId,
          clusterId,
          serviceId,
          action: 'MUTATION_CONVERGENCE_FAILED',
          afterJson: verification.current.service,
        });
      } else {
        await this.operations.markNeedsAttention(
          connection,
          operationId,
          'VERIFICATION_TIMEOUT',
          'Service mutation was accepted but convergence was not confirmed',
        );
        await this.operations.audit(connection, {
          operationId,
          actorId: principal.actorId,
          clusterId,
          serviceId,
          action: 'MUTATION_NEEDS_ATTENTION',
          afterJson: verification.current?.service,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    const operation = await this.operations.find(operationId);
    if (!operation) {
      throw new Error('Operation disappeared after persistence');
    }
    return operation;
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

function mapAgentError(error: unknown): Error {
  if (error instanceof AgentRequestError && error.statusCode === 409) {
    return new ConflictException('Agent rejected stale service version');
  }
  return new BadGatewayException('Agent mutation failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
