import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PoolConnection } from 'mysql2/promise';
import { ClusterRegistrationRepository } from './cluster-registration.repository.js';
import { isBoundedIdentifier } from './cluster-registration.types.js';

export const CLUSTER_BINDING_SETTINGS = Symbol('CLUSTER_BINDING_SETTINGS');
export interface ClusterBindingSettings {
  mode: 'compat' | 'enforce';
  logicalClusterId: string;
  expectedSwarmClusterId: string | null;
}

export function loadClusterBindingSettings(env: NodeJS.ProcessEnv = process.env): ClusterBindingSettings {
  const mode = env.DOCKLANE_CLUSTER_REGISTRATION_MODE ?? 'compat';
  if (mode !== 'compat' && mode !== 'enforce') {
    throw new Error('DOCKLANE_CLUSTER_REGISTRATION_MODE must be compat or enforce');
  }
  const logicalClusterId = env.DOCKLANE_CLUSTER_ID ?? 'default';
  if (!isBoundedIdentifier(logicalClusterId)) {
    throw new Error('DOCKLANE_CLUSTER_ID must be a bounded identifier');
  }
  const expectedSwarmClusterId = env.DOCKLANE_EXPECTED_CLUSTER_ID ?? null;
  if (mode === 'enforce' && !isBoundedIdentifier(expectedSwarmClusterId)) {
    throw new Error('Registration enforcement requires a fixed Swarm cluster ID');
  }
  return { mode, logicalClusterId, expectedSwarmClusterId };
}

export class ClusterBindingUnavailable extends ServiceUnavailableException {
  constructor(code: 'CLUSTER_REGISTRATION_REQUIRED' | 'CLUSTER_REGISTRATION_MISMATCH' | 'CLUSTER_REGISTRATION_UNAVAILABLE') {
    super({ code, message: 'Configured cluster registration is unavailable' });
  }
}

@Injectable()
export class ClusterBindingPolicy {
  constructor(
    @Inject(ClusterRegistrationRepository) private readonly registrations: ClusterRegistrationRepository,
    @Inject(CLUSTER_BINDING_SETTINGS) readonly settings: ClusterBindingSettings,
  ) {}

  private readonly lockedScope = new AsyncLocalStorage<{ connection: PoolConnection; active: boolean }>();
  get clusterId(): string { return this.settings.logicalClusterId; }
  async withLockedConnection<T>(connection: PoolConnection, callback: () => Promise<T>): Promise<T> {
    const scope = { connection, active: true };
    return this.lockedScope.run(scope, async () => {
      try { return await callback(); }
      finally { scope.active = false; }
    });
  }

  async assertRegistered(clusterId: string = this.clusterId): Promise<void> {
    if (clusterId !== this.clusterId) throw new NotFoundException('Cluster not found');
    if (this.settings.mode !== 'enforce') return;
    let record;
    try {
      // Deliberately no successful-registration cache across requests or restarts.
      const scope = this.lockedScope.getStore();
      record = scope?.active
        ? await this.registrations.findWithConnection(scope.connection, clusterId)
        : await this.registrations.find(clusterId);
    } catch {
      throw new ClusterBindingUnavailable('CLUSTER_REGISTRATION_UNAVAILABLE');
    }
    if (!record) throw new ClusterBindingUnavailable('CLUSTER_REGISTRATION_REQUIRED');
    if (record.clusterId !== clusterId || record.swarmClusterId !== this.settings.expectedSwarmClusterId) {
      throw new ClusterBindingUnavailable('CLUSTER_REGISTRATION_MISMATCH');
    }
  }
}
