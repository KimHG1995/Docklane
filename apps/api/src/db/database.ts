import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import mysql, {
  type Pool,
  type PoolConnection,
  type QueryResult,
} from 'mysql2/promise';
import { runDatabaseMigrations } from './migrations.js';

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const url = process.env.DOCKLANE_DATABASE_URL;
    if (!url) {
      throw new Error('DOCKLANE_DATABASE_URL is required');
    }
    this.pool = mysql.createPool({
      uri: url,
      connectionLimit: 10,
      enableKeepAlive: true,
      timezone: 'Z',
    });
  }

  async onModuleInit(): Promise<void> {
    const connection = await this.getConnection();
    try {
      await runDatabaseMigrations(connection);
    } finally {
      connection.release();
    }
  }

  async query<T extends QueryResult>(
    sql: string,
    values?: unknown[],
  ) {
    const connection = await this.getConnection();
    try {
      return values === undefined
        ? await connection.query<T>(sql)
        : await connection.query<T>(sql, values);
    } finally {
      connection.release();
    }
  }

  async getConnection(): Promise<PoolConnection> {
    const connection = await this.pool.getConnection();
    try {
      await connection.query("SET time_zone = '+00:00'");
      return connection;
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
