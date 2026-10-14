import pg from 'pg';
import type { DatabaseConfig } from '../config.js';
import { describeDatabaseUrl } from '../config.js';

export interface LogSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createPool(config: DatabaseConfig, logger: LogSink): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    application_name: 'rff-api',
  });
  // An idle client whose connection drops (a server restart, pg_terminate_backend)
  // emits 'error' on the pool. Without a listener Node treats it as an uncaught
  // exception and the process exits. The pool has already discarded that client.
  pool.on('error', (error) => {
    logger.error(
      `idle database connection to ${describeDatabaseUrl(config.url)} failed: ${error.message}`,
    );
  });
  return pool;
}
