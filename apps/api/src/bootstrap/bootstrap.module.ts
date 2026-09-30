import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { BootstrapRepository } from './bootstrap.repository.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [DbModule],
  controllers: [BootstrapController],
  providers: [BootstrapRepository, BootstrapService],
  exports: [BootstrapService],
})
export class BootstrapModule {}
