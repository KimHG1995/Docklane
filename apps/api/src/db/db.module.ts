import { Module } from '@nestjs/common';
import { Database } from './database.js';

@Module({
  providers: [Database],
  exports: [Database],
})
export class DbModule {}
