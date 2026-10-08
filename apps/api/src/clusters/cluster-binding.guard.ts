import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClusterBindingPolicy } from './cluster-binding.policy.js';

const SKIP_CLUSTER_BINDING = 'docklane:skip-cluster-binding';
const REQUIRE_CLUSTER_BINDING = 'docklane:require-cluster-binding';

export const SkipClusterBinding = () => SetMetadata(SKIP_CLUSTER_BINDING, true);
export const RequireClusterBinding = () => SetMetadata(REQUIRE_CLUSTER_BINDING, true);

@Injectable()
export class ClusterBindingGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ClusterBindingPolicy) private readonly policy: ClusterBindingPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CLUSTER_BINDING, targets)) return true;
    const request = context.switchToHttp().getRequest<{ params?: Record<string, string | undefined> }>();
    const clusterId = request.params?.clusterId;
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_CLUSTER_BINDING, targets);
    if (clusterId !== undefined || required) {
      await this.policy.assertRegistered(clusterId ?? this.policy.clusterId);
    }
    return true;
  }
}
