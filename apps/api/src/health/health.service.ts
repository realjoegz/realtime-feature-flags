import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../tokens.js';

@Injectable()
export class HealthService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** True when the database answers a query through the app's pool. */
  async databaseAnswers(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
