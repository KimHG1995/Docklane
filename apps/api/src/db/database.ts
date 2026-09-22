import { Injectable, OnModuleDestroy } from '@nestjs/common';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const url = process.env.DOCKLANE_DATABASE_URL;
    if (!url) {
      throw new Error('DOCKLANE_DATABASE_URL is required');
    }
    this.pool = mysql.createPool({
      uri: url,
      connectionLimit: 10,
      enableKeepAlive: true,
    });
  }

  getConnection(): Promise<PoolConnection> {
    return this.pool.getConnection();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
