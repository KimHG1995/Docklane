import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException, UnauthorizedException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../auth/auth.guard.js';
import { REQUIRED_ROLE } from '../auth/auth.decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/auth.types.js';
import type { TokenRegistry } from '../auth/token-registry.js';
import { ClusterRegistrationController } from './cluster-registration.controller.js';
import type { ClusterRegistrationService } from './cluster-registration.service.js';

const admin: Principal = { actorId: 'admin', role: 'ADMIN', clusters: ['default'] };
const request = () => ({ principal: admin } as AuthenticatedRequest);
const input = { swarmClusterId: 'swarm-a', displayName: '공공 운영' };

function fixture() {
  const calls: unknown[][] = [];
  const controller = new ClusterRegistrationController({
    register(...args: unknown[]) { calls.push(args); return Promise.resolve({}); },
    get(...args: unknown[]) { calls.push(args); return Promise.resolve({}); },
  } as unknown as ClusterRegistrationService);
  return { calls, controller };
}

test('registration exposes separate PUT and GET paths under ADMIN protection', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, ClusterRegistrationController), 'v1/clusters/:clusterId/registration');
  assert.equal(Reflect.getMetadata(REQUIRED_ROLE, ClusterRegistrationController), 'ADMIN');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, ClusterRegistrationController.prototype.register), RequestMethod.PUT);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, ClusterRegistrationController.prototype.get), RequestMethod.GET);
});

test('real authorization guard denies missing tokens, wrong roles and foreign scopes on both handlers', () => {
  for (const handler of ['register', 'get'] as const) {
    for (const principal of [null, { ...admin, role: 'VIEWER' as const },
      { ...admin, role: 'OPERATOR' as const }, { ...admin, clusters: ['other'] }]) {
      const req = { headers: { authorization: 'Bearer test-only-token' }, params: { clusterId: 'default' } };
      const context = {
        getHandler: () => ClusterRegistrationController.prototype[handler],
        getClass: () => ClusterRegistrationController,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      const guard = new AuthGuard(new Reflector(), { authenticate: () => principal } as unknown as TokenRegistry);
      assert.throws(() => guard.canActivate(context), principal === null ? UnauthorizedException : ForbiddenException);
    }
  }
});

test('strict DTO rejects extra endpoint/credential fields and malformed identifiers before the service', () => {
  const f = fixture();
  for (const body of [null, [], {}, { ...input, endpoint: 'http://untrusted' },
    { ...input, key: 'secret' }, { ...input, clusterId: 'other' },
    ...['', 'swarm-a\n', ' swarm-a', 'a/b', 'a'.repeat(129)].map((swarmClusterId) => ({ ...input, swarmClusterId })),
    ...['', '  ', 'name\n', '\u0000name', 'a'.repeat(129)].map((displayName) => ({ ...input, displayName })),
  ]) {
    assert.throws(() => f.controller.register('default', body, request()), BadRequestException);
  }
  assert.equal(f.calls.length, 0);
});

test('valid registration forwards only validated metadata and authenticated actor', async () => {
  const f = fixture();
  await f.controller.register('default', input, request());
  assert.deepEqual(f.calls, [['default', input, admin]]);
  await f.controller.get('default', request());
  assert.deepEqual(f.calls[1], ['default', admin]);
});

test('direct controller calls without a principal cannot reach persistence', () => {
  const f = fixture();
  assert.throws(() => f.controller.register('default', input, {} as AuthenticatedRequest), UnauthorizedException);
  assert.throws(() => f.controller.get('default', {} as AuthenticatedRequest), UnauthorizedException);
  assert.equal(f.calls.length, 0);
});
