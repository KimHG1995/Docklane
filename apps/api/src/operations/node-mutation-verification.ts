import type { NodeDetailResponse } from '../agent/read-model.js';
import type { NodeOperationRecord } from './operation.types.js';

export type NodeMutationDecision =
  | { status: 'PENDING' }
  | { status: 'SUCCESS' }
  | { status: 'EXTERNAL_CONFLICT'; message: string };

export function classifyNodeMutation(
  operation: NodeOperationRecord,
  current: NodeDetailResponse,
): NodeMutationDecision {
  if (
    operation.resultVersion !== null &&
    current.node.version < operation.resultVersion
  ) {
    return { status: 'PENDING' };
  }

  if (current.node.specHash !== operation.targetSpecHash) {
    return {
      status: 'EXTERNAL_CONFLICT',
      message: 'Current node spec no longer matches the recorded mutation target',
    };
  }

  if (current.node.availability !== operation.targetAvailability) {
    return { status: 'PENDING' };
  }

  if (operation.type === 'ACTIVATE') {
    return { status: 'SUCCESS' };
  }

  const remainingServiceTasks = current.tasks.filter(
    (task) => task.serviceId.length > 0,
  );
  return remainingServiceTasks.length === 0
    ? { status: 'SUCCESS' }
    : { status: 'PENDING' };
}
