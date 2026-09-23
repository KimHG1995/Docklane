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

  if (operation.type === 'LABELS') {
    if (!operation.targetLabels) {
      return {
        status: 'EXTERNAL_CONFLICT',
        message: 'Recorded label mutation target is missing',
      };
    }
    return sameLabels(current.node.labels, operation.targetLabels)
      ? { status: 'SUCCESS' }
      : {
          status: 'EXTERNAL_CONFLICT',
          message: 'Current node labels do not match the recorded target',
        };
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


function sameLabels(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && left[key] === right[key],
    )
  );
}
