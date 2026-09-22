import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE, REQUIRED_ROLE } from './auth.decorators.js';
import { TokenRegistry } from './token-registry.js';
import type { AuthenticatedRequest, Role } from './auth.types.js';

const ROLE_RANK: Record<Role, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token is required');

    const principal = this.tokens.authenticate(token);
    if (!principal) throw new UnauthorizedException('Invalid bearer token');

    const requiredRole =
      this.reflector.getAllAndOverride<Role>(REQUIRED_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'VIEWER';
    if (ROLE_RANK[principal.role] < ROLE_RANK[requiredRole]) {
      throw new ForbiddenException('Insufficient role');
    }

    const clusterId = request.params.clusterId;
    if (
      clusterId &&
      !principal.clusters.includes('*') &&
      !principal.clusters.includes(clusterId)
    ) {
      throw new ForbiddenException('Cluster scope denied');
    }

    request.principal = principal;
    return true;
  }
}

function readBearerToken(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ', 2);
  return scheme === 'Bearer' && token ? token : null;
}
