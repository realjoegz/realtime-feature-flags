import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import pg from 'pg';
import { type Config, describeDatabaseUrl } from '../config.js';
import { createPool } from './pool.js';
import { withConnectRetry } from './retry.js';
import { assertUnprivilegedRole } from './role-check.js';
import { CONFIG, PG_POOL } from '../tokens.js';

// The pool is ready only after the role check has passed: Nest resolves this factory
// before it creates any controller, so a refused role stops NestFactory.create.
export const poolProvider: Provider = {
  provide: PG_POOL,
  inject: [CONFIG],
  useFactory: async (config: Config): Promise<pg.Pool> => {
    const logger = new Logger('Database');
    const pool = createPool(config.database, logger);
    try {
      await withConnectRetry(() => assertUnprivilegedRole(pool), {
        deadlineMs: config.database.connectDeadlineMs,
        onRetry: (attempt, error, delayMs) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`connect attempt ${attempt} failed (${message}), retrying in ${delayMs} ms`);
        },
      });
    } catch (error) {
      await pool.end();
      throw error;
    }
    logger.log(`connected as ${describeDatabaseUrl(config.database.url)}`);
    return pool;
  },
};

@Injectable()
export class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
