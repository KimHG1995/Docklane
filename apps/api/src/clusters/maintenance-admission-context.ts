import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolConnection } from 'mysql2/promise';

/**
 * A durable admission starts before operation intent exists. Once its
 * operation ID is known, bind it on the same lock session before HTTP send.
 * A crash before that point leaves owner/resource identity available.
 */
interface AdmissionScope {
  id: string;
  clusterId: string;
  connection: PoolConnection;
}
const scope = new AsyncLocalStorage<AdmissionScope>();
export function withActiveAdmission<T>(context: AdmissionScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(context, fn);
}
export function currentActiveAdmission(): AdmissionScope | null {
  return scope.getStore() ?? null;
}
