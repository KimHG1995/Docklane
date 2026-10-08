import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { TokenRegistry } from './token-registry.js';
import { ClusterBindingModule } from '../clusters/cluster-binding.module.js';
import { ClusterBindingGuard } from '../clusters/cluster-binding.guard.js';

@Module({
  imports: [ClusterBindingModule],
  providers: [
    TokenRegistry,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ClusterBindingGuard },
  ],
})
export class AuthModule {}
