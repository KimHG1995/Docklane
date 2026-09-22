import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { TokenRegistry } from './token-registry.js';

@Module({
  providers: [
    TokenRegistry,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
