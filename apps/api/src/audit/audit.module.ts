import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AuditRepository } from './audit.repository.js';

@Module({
  imports: [DbModule],
  providers: [AuditRepository],
  exports: [AuditRepository],
})
export class AuditModule {}
