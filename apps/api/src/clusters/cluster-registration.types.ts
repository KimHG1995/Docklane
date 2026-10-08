export interface RegisterClusterRequest {
  swarmClusterId: string;
  displayName: string;
}

export interface ClusterRegistrationRecord extends RegisterClusterRequest {
  id: string;
  clusterId: string;
  registeredBy: string;
  verifiedNodeId: string;
  createdAt: string;
}

export interface ClusterRegistrationView {
  registration: ClusterRegistrationRecord;
  configuredSwarmClusterId: string | null;
  matchesConfiguration: boolean;
}

export function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[^A-Za-z0-9_-]/.test(value);
}

export function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function matchesRegistration(
  record: ClusterRegistrationRecord,
  input: RegisterClusterRequest & { clusterId: string },
): boolean {
  return record.clusterId === input.clusterId &&
    record.swarmClusterId === input.swarmClusterId && record.displayName === input.displayName;
}
