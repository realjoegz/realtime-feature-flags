import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import { type Config } from '../src/config.js';
import { PG_POOL } from '../src/tokens.js';
import { harness } from './harness/context.js';
import { apiConfig, UNUSED_AUTH } from './support/api.js';

function config(instance: string): Config {
  const base = apiConfig(harness().appUrl, UNUSED_AUTH, instance);
  return { ...base, database: { ...base.database, poolMax: 2 } };
}

async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('GET /health', () => {
  it('answers 200 with the instance name when the database answers, as rff_app', async () => {
    const app = await createApp(config('health-1'), { logger: false });
    try {
      const base = await listen(app);
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', instance: 'health-1' });
      const pool = app.get<pg.Pool>(PG_POOL);
      const { rows } = await pool.query('SELECT current_user AS role');
      expect(rows).toEqual([{ role: 'rff_app' }]);
    } finally {
      await app.close();
    }
  });

  it('answers 503 when the database does not answer', async () => {
    const failingPool = {
      query: async () => {
        throw new Error('connection refused');
      },
      end: async () => {},
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config('health-2'))],
    })
      .overrideProvider(PG_POOL)
      .useValue(failingPool)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false, forceCloseConnections: true });
    try {
      const base = await listen(app);
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable', instance: 'health-2' });
    } finally {
      await app.close();
    }
  });
});

describe('response headers', () => {
  it('createApp sends no X-Powered-By header on a 200 or on a 404', async () => {
    const app = await createApp(config('health-5'), { logger: false });
    try {
      const base = await listen(app);
      const ok = await fetch(`${base}/health`);
      expect(ok.status).toBe(200);
      expect(ok.headers.has('x-powered-by')).toBe(false);
      const missing = await fetch(`${base}/no-such-route`);
      expect(missing.status).toBe(404);
      expect(missing.headers.has('x-powered-by')).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('shutdown', () => {
  it('createApp enables the shutdown hooks, and close() ends the pool', async () => {
    const before = process.listenerCount('SIGTERM');
    const app = await createApp(config('health-3'), { logger: false });
    const pool = app.get<pg.Pool>(PG_POOL);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await app.close();
    expect(pool.ended).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  // Without forceCloseConnections, close() would wait for that response forever.
  it(
    'close() returns at once while a request is still waiting for its response',
    { timeout: 5000 },
    async () => {
      const app = await createApp(config('health-4'), { logger: false });
      const base = await listen(app);
      // The health query never answers, so the request below stays in flight.
      const pool = app.get<pg.Pool>(PG_POOL);
      let queried!: () => void;
      const reachedQuery = new Promise<void>((done) => (queried = done));
      pool.query = (() => {
        queried();
        return new Promise(() => {});
      }) as unknown as pg.Pool['query'];
      const response = fetch(`${base}/health`).then(
        () => 'answered',
        () => 'connection closed',
      );
      await reachedQuery;
      const started = performance.now();
      await app.close();
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await response).toBe('connection closed');
    },
  );
});
