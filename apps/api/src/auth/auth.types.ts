export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';

export interface Principal {
  actorId: string;
  role: Role;
  clusters: string[];
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  principal?: Principal;
}
