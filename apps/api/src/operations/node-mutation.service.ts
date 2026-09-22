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
  NodeDetailResponse,
  NodeMutationPlan,
  NodeMutationResponse,
} from '../agent/read-model.js';
import type { Principal } from '../auth/auth.types.js';
import { OperationLock } from './operation-lock.js';
import { OperationRepository } from './operation.repository.js';
import { NodeOperationRepository } from './node-operation.repository.js';
import type { NodeMutationRequest } from './node-mutation.dto.js';
import { classifyNodeMutation } from './node-mutation-verification.js';
import type {
  NodeOperationRecord,
  NodeOperationType,
} from './operation.types.js';

const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 500;

@Injectable()
export class NodeMutationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NodeMutationService.name);
  private readonly clusterId = process.env.DOCKLANE_CLUSTER_ID ?? 'default';

  constructor(
    @Inject(AGENT_CLIENT) private readonly agentClient: AgentClient,
    @Inject(NodeOperationRepository)
    private readonly nodeOperations: NodeOperationRepository,
    @Inject(OperationRepository)
    private readonly serviceOperations: OperationRepository,
    @Inject(OperationLock) private readonly lock: OperationLock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pending = await this.nodeOperations.listNonTerminal();
    for (const operation of pending) {
      try {
        await this.lock.withNodeAndServiceLocks(
          operation.clusterId,
          operation.nodeId,
          operation.affectedServiceIds,
          async (connection) => {
            const current = await this.nodeOperations.findWithConnection(
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
          `Failed to reconcile node operation ${operation.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async operation(
    clusterId: string,
    operationId: string,
  ): Promise<NodeOperationRecord> {
    this.assertCluster(clusterId);
    const operation = await this.nodeOperations.find(operationId);
    if (!operation || operation.clusterId !== clusterId) {
      throw new NotFoundException('Node operation not found');
    }
    return operation;
  }

  drain(
    clusterId: string,
    nodeRef: string,
    input: NodeMutationRequest,
    principal: Principal,
  ): Promise<NodeOperationRecord> {
    return this.mutate(
      clusterId,
      nodeRef,
      input,
      principal,
      'DRAIN',
    );
  }

  activate(
    clusterId: string,
    nodeRef: string,
    input: NodeMutationRequest,
    principal: Principal,
  ): Promise<NodeOperationRecord> {
    return this.mutate(
      clusterId,
      nodeRef,
      input,
      principal,
      'ACTIVATE',
    );
  }

  private async mutate(
    clusterId: string,
    nodeRef: string,
    input: NodeMutationRequest,
    principal: Principal,
    type: NodeOperationType,
  ): Promise<NodeOperationRecord> {
    this.assertCluster(clusterId);

    const initial = await this.agentClient.inspectNode(nodeRef);
    const canonicalNodeId = initial.node.id;
    const initiallyAffected = sortedUnique(initial.serviceIds);

    return this.lock.withNodeAndServiceLocks(
      clusterId,
      canonicalNodeId,
      initiallyAffected,
      async (connection) => {
        const existing = await this.nodeOperations.findWithConnection(
          connection,
          input.operationId,
        );
        if (existing) {
          this.assertIdempotent(existing, {
            clusterId,
            nodeId: canonicalNodeId,
            type,
            actorId: principal.actorId,
            expectedVersion: input.expectedVersion,
          });
          return isTerminal(existing)
            ? existing
            : this.reconcileLocked(connection, existing);
        }

        const prior = await this.nodeOperations.findNonTerminalForNodeWithConnection(
          connection,
          clusterId,
          canonicalNodeId,
        );
        if (prior) {
          const reconciled = await this.reconcileLocked(connection, prior);
          if (!isTerminal(reconciled)) {
            throw new ConflictException(
              `Node has unresolved operation ${reconciled.id} (${reconciled.status})`,
            );
          }
        }

        const lockedNode = await this.agentClient.inspectNode(canonicalNodeId);
        const lockedServices = sortedUnique(lockedNode.serviceIds);
        if (!sameStrings(initiallyAffected, lockedServices)) {
          throw new ConflictException(
            'Node task set changed while acquiring mutation locks; retry the operation',
          );
        }

        for (const serviceId of lockedServices) {
          const serviceOperation =
            await this.serviceOperations.findNonTerminalForServiceWithConnection(
              connection,
              clusterId,
              serviceId,
            );
          if (serviceOperation) {
            throw new ConflictException(
              `Service ${serviceId} has unresolved operation ${serviceOperation.id}`,
            );
          }
        }

        const plan = await this.plan(
          type,
          canonicalNodeId,
          input.expectedVersion,
        );
        this.assertPlanMatchesLockedNode(plan, lockedNode, lockedServices);

        await this.persistIntent(
          connection,
          input.operationId,
          clusterId,
          type,
          principal.actorId,
          plan,
          lockedNode,
        );

        if (plan.beforeSpecHash === plan.targetSpecHash) {
          const operation = await this.requireOperation(
            connection,
            input.operationId,
          );
          return this.verifyAndCompleteLocked(connection, operation);
        }

        try {
          const accepted = await this.execute(type, canonicalNodeId, plan);
          this.assertAcceptedMatchesPlan(accepted, plan);
          await this.nodeOperations.markVerifying(
            connection,
            input.operationId,
            accepted.version,
          );
        } catch (error) {
          if (isDeterministicAgentRejection(error)) {
            await this.markRejected(
              connection,
              input.operationId,
              principal.actorId,
              clusterId,
              canonicalNodeId,
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

  private plan(
    type: NodeOperationType,
    nodeId: string,
    expectedVersion: number,
  ): Promise<NodeMutationPlan> {
    return type === 'DRAIN'
      ? this.agentClient.planDrainNode(nodeId, expectedVersion)
      : this.agentClient.planActivateNode(nodeId, expectedVersion);
  }

  private execute(
    type: NodeOperationType,
    nodeId: string,
    plan: NodeMutationPlan,
  ): Promise<NodeMutationResponse> {
    const input = {
      expectedVersion: plan.version,
      expectedSpecHash: plan.beforeSpecHash,
      targetSpecHash: plan.targetSpecHash,
    };
    return type === 'DRAIN'
      ? this.agentClient.drainNode(nodeId, input)
      : this.agentClient.activateNode(nodeId, input);
  }

  private async persistIntent(
    connection: PoolConnection,
    operationId: string,
    clusterId: string,
    type: NodeOperationType,
    actorId: string,
    plan: NodeMutationPlan,
    before: NodeDetailResponse,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.nodeOperations.create(connection, {
        id: operationId,
        clusterId,
        nodeId: plan.nodeId,
        type,
        actorId,
        expectedVersion: plan.version,
        beforeSpecHash: plan.beforeSpecHash,
        targetSpecHash: plan.targetSpecHash,
        targetAvailability: plan.targetAvailability,
        affectedServiceIds: plan.affectedServiceIds,
      });
      await this.nodeOperations.markRunning(connection, operationId);
      await this.serviceOperations.audit(connection, {
        operationId,
        actorId,
        clusterId,
        serviceId: plan.nodeId,
        resourceType: 'node',
        resourceId: plan.nodeId,
        action: `NODE_${type}_STARTED`,
        beforeJson: before.node,
        afterJson: {
          targetSpecHash: plan.targetSpecHash,
          targetAvailability: plan.targetAvailability,
          affectedServiceIds: plan.affectedServiceIds,
        },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async reconcileLocked(
    connection: PoolConnection,
    operation: NodeOperationRecord,
  ): Promise<NodeOperationRecord> {
    let current: NodeDetailResponse;
    try {
      current = await this.agentClient.inspectNode(operation.nodeId);
    } catch (error) {
      await this.markNeedsAttention(
        connection,
        operation,
        'NODE_RECONCILIATION_UNAVAILABLE',
        `Unable to inspect node: ${errorMessage(error)}`,
      );
      return this.requireOperation(connection, operation.id);
    }

    if (current.node.specHash === operation.targetSpecHash) {
      if (operation.status !== 'VERIFYING') {
        await this.nodeOperations.markVerifying(
          connection,
          operation.id,
          current.node.version,
        );
      }
      const refreshed = await this.requireOperation(connection, operation.id);
      return this.verifyAndCompleteLocked(connection, refreshed);
    }

    if (
      current.node.version === operation.expectedVersion &&
      current.node.specHash === operation.beforeSpecHash
    ) {
      await this.markNeedsAttention(
        connection,
        operation,
        'NODE_MUTATION_NOT_OBSERVED',
        'Node mutation outcome is uncertain and target state was not observed',
      );
      return this.requireOperation(connection, operation.id);
    }

    await this.markNeedsAttention(
      connection,
      operation,
      'EXTERNAL_NODE_CONFLICT',
      'Node spec changed outside the recorded Docklane mutation',
      current.node,
    );
    return this.requireOperation(connection, operation.id);
  }

  private async verifyAndCompleteLocked(
    connection: PoolConnection,
    operation: NodeOperationRecord,
  ): Promise<NodeOperationRecord> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last: NodeDetailResponse | null = null;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      try {
        const current = await this.agentClient.inspectNode(operation.nodeId);
        last = current;
        lastError = null;
        const decision = classifyNodeMutation(operation, current);

        if (decision.status === 'SUCCESS') {
          await connection.beginTransaction();
          try {
            await this.nodeOperations.markSuccess(
              connection,
              operation.id,
              current.node.version,
            );
            await this.serviceOperations.audit(connection, {
              operationId: operation.id,
              actorId: operation.actorId,
              clusterId: operation.clusterId,
              serviceId: operation.nodeId,
              resourceType: 'node',
              resourceId: operation.nodeId,
              action: `NODE_${operation.type}_SUCCEEDED`,
              afterJson: {
                node: current.node,
                remainingTasks: current.tasks,
              },
            });
            await connection.commit();
          } catch (error) {
            await connection.rollback();
            throw error;
          }
          return this.requireOperation(connection, operation.id);
        }

        if (decision.status === 'EXTERNAL_CONFLICT') {
          await this.markNeedsAttention(
            connection,
            operation,
            'EXTERNAL_NODE_CONFLICT',
            decision.message,
            current.node,
          );
          return this.requireOperation(connection, operation.id);
        }
      } catch (error) {
        lastError = errorMessage(error);
      }

      await sleep(VERIFY_INTERVAL_MS);
    }

    await this.markNeedsAttention(
      connection,
      operation,
      'NODE_VERIFICATION_UNCERTAIN',
      lastError
        ? `Node verification timed out after Agent errors: ${lastError}`
        : 'Node mutation was accepted but convergence was not confirmed',
      last?.node,
    );
    return this.requireOperation(connection, operation.id);
  }

  private async markRejected(
    connection: PoolConnection,
    operationId: string,
    actorId: string,
    clusterId: string,
    nodeId: string,
    error: AgentRequestError,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.nodeOperations.markFailed(
        connection,
        operationId,
        error.statusCode === 409
          ? 'NODE_VERSION_CONFLICT'
          : 'NODE_MUTATION_REJECTED',
        error.responseBody,
      );
      await this.serviceOperations.audit(connection, {
        operationId,
        actorId,
        clusterId,
        serviceId: nodeId,
        resourceType: 'node',
        resourceId: nodeId,
        action: 'NODE_MUTATION_REJECTED',
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
    operation: NodeOperationRecord,
    code: string,
    message: string,
    current?: unknown,
  ): Promise<void> {
    await connection.beginTransaction();
    try {
      await this.nodeOperations.markNeedsAttention(
        connection,
        operation.id,
        code,
        message,
      );
      await this.serviceOperations.audit(connection, {
        operationId: operation.id,
        actorId: operation.actorId,
        clusterId: operation.clusterId,
        serviceId: operation.nodeId,
        resourceType: 'node',
        resourceId: operation.nodeId,
        action: 'NODE_MUTATION_NEEDS_ATTENTION',
        afterJson: current ?? { code, message },
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
  ): Promise<NodeOperationRecord> {
    const operation = await this.nodeOperations.findWithConnection(
      connection,
      operationId,
    );
    if (!operation) {
      throw new Error('Node operation disappeared after persistence');
    }
    return operation;
  }

  private assertPlanMatchesLockedNode(
    plan: NodeMutationPlan,
    locked: NodeDetailResponse,
    lockedServices: string[],
  ): void {
    if (
      plan.nodeId !== locked.node.id ||
      plan.version !== locked.node.version ||
      plan.beforeSpecHash !== locked.node.specHash ||
      !sameStrings(sortedUnique(plan.affectedServiceIds), lockedServices)
    ) {
      throw new ConflictException(
        'Node changed between lock acquisition and mutation planning',
      );
    }
  }

  private assertAcceptedMatchesPlan(
    accepted: NodeMutationResponse,
    plan: NodeMutationPlan,
  ): void {
    if (
      accepted.nodeId !== plan.nodeId ||
      accepted.targetSpecHash !== plan.targetSpecHash ||
      accepted.targetAvailability !== plan.targetAvailability
    ) {
      throw new ConflictException(
        'Agent node mutation response does not match the recorded target',
      );
    }
  }

  private assertIdempotent(
    existing: NodeOperationRecord,
    expected: {
      clusterId: string;
      nodeId: string;
      type: NodeOperationType;
      actorId: string;
      expectedVersion: number;
    },
  ): void {
    if (
      existing.clusterId !== expected.clusterId ||
      existing.nodeId !== expected.nodeId ||
      existing.type !== expected.type ||
      existing.actorId !== expected.actorId ||
      existing.expectedVersion !== expected.expectedVersion
    ) {
      throw new ConflictException(
        'operationId was already used for a different node mutation',
      );
    }
  }

  private assertCluster(clusterId: string): void {
    if (clusterId !== this.clusterId) {
      throw new NotFoundException('Cluster not found');
    }
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isTerminal(operation: NodeOperationRecord): boolean {
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
    return new ConflictException('Agent rejected stale node state');
  }
  return new BadGatewayException('Agent rejected node mutation request');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
