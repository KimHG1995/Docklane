export type BootstrapNodeRole = 'manager' | 'worker';

export interface BootstrapScope {
  clusterId: string;
  nodeRole: BootstrapNodeRole;
  labels: Record<string, string>;
}

export interface BootstrapTokenRecord extends BootstrapScope {
  id: string;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
  claimId: string | null;
  createdAt: string;
}

export interface BootstrapTokenIssueResponse extends BootstrapTokenRecord {
  token: string;
}

export interface BootstrapClaimResponse extends BootstrapScope {
  tokenId: string;
  expiresAt: string;
  claimedAt: string;
  claimId: string;
  replayed: boolean;
  swarmJoin: {
    remoteAddr: string;
    joinToken: string;
  };
}
