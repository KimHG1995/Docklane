import type { ServiceDetailResponse } from '../agent/read-model.js';
import type { OperationRecord } from './operation.types.js';

export type MutationSnapshotDecision =
  | { status: 'PENDING' }
  | { status: 'SUCCESS' }
  | { status: 'FAILED'; message: string }
  | { status: 'EXTERNAL_CONFLICT'; message: string };

export function classifyMutationSnapshot(
  operation: OperationRecord,
  current: ServiceDetailResponse,
): MutationSnapshotDecision {
  if (current.service.specHash !== operation.targetSpecHash) {
    return {
      status: 'EXTERNAL_CONFLICT',
      message:
        'Current service spec no longer matches the recorded mutation target',
    };
  }

  // Docker/Swarm metadata versions may advance after ServiceUpdate is
  // accepted (for example while UpdateStatus is written). Treat the accepted
  // version as a lower bound only, not as the identity of the final state.
  if (
    operation.resultVersion !== null &&
    current.service.version < operation.resultVersion
  ) {
    return { status: 'PENDING' };
  }

  const state = current.service.updateState;
  if (
    state === 'paused' ||
    state === 'rollback_started' ||
    state === 'rollback_completed'
  ) {
    return {
      status: 'FAILED',
      message: `Unexpected update state: ${state}`,
    };
  }

  if (current.service.forceUpdate !== operation.targetForceUpdate) {
    return { status: 'PENDING' };
  }

  if (
    current.service.desiredReplicas !== current.service.runningReplicas
  ) {
    return { status: 'PENDING' };
  }

  if (operation.type === 'SCALE') {
    return current.service.desiredReplicas === operation.targetReplicas
      ? { status: 'SUCCESS' }
      : { status: 'PENDING' };
  }

  if (current.service.updateState !== 'completed') {
    return { status: 'PENDING' };
  }

  const runningTasks = current.tasks.filter(
    (task) => task.state === 'running',
  );

  if (
    runningTasks.length !== current.service.desiredReplicas ||
    !runningTasks.every(
      (task) => task.forceUpdate === operation.targetForceUpdate,
    )
  ) {
    return { status: 'PENDING' };
  }

  return { status: 'SUCCESS' };
}
