import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolConnection } from 'mysql2/promise';

/**
 * Operation identity must come from the durable intent, never be invented by
 * the transport or inferred from service IDs. This scope does not change the
 * Agent HTTP/OpenAPI contract.
 */
const operationScope = new AsyncLocalStorage<string>();
export interface MutationAdmission {
  clusterId: string;
  generation: bigint;
  connection: PoolConnection | null;
}
const admissionScope = new AsyncLocalStorage<MutationAdmission>();

export function withMutationOperation<T>(operationId: string, run: () => Promise<T>): Promise<T> {
  if (!operationId || operationId.length > 64) {
    throw new Error('Durable operation ID is required for mutation dispatch');
  }
  return operationScope.run(operationId, run);
}

export function currentMutationOperation(): string | null {
  return operationScope.getStore() ?? null;
}

/**
 * Set only after the registered client has verified current OPEN maintenance
 * state. The scoped connection belongs to the resource lock and MUST NOT be
 * cached after its callback returns.
 */
export function withMutationAdmission<T>(
  scope: MutationAdmission,
  run: () => Promise<T>,
): Promise<T> {
  return admissionScope.run(scope, run);
}

export function currentMutationAdmission(): MutationAdmission | null {
  return admissionScope.getStore() ?? null;
}
