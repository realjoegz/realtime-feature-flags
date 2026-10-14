import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import { connectClient } from '../src/database/connect.js';
import { MIGRATIONS_DIR, readMigrations } from '../src/migrator.js';
import { adminClient, harness, type HarnessContext } from './harness/context.js';
import setup from './harness/global-setup.js';
import { connectRedis, escapeGlob, removeKeysWithPrefix } from './harness/redis.js';
import { createDatabase, dropAbandonedRuns, dropRun } from './harness/runs.js';
import { ident, literal } from './harness/settings.js';

// The test harness (harness/global-setup.ts) gives each run of the api project its own
// database and Redis prefix, so concurrent runs against the one compose stack do not
// see each other's data.

describe('test harness', () => {
  it("this run's database is rff_test_<run id>, built by the migration runner from apps/api/migrations", async () => {
    const run = harness();
    expect(run.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(run.database).toBe(`rff_test_${run.runId}`);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
      expect(rows).toEqual([{ db: run.database }]);
      const recorded = await admin.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const files = await readMigrations(MIGRATIONS_DIR);
      expect(recorded.rows).toEqual(
        files.map(({ version, name, checksum }) => ({ version, name, checksum })),
      );
    } finally {
      await admin.end();
    }
  });

  it("this run's Redis prefix is rff_test_<run id>, and removing a run's keys leaves other keys alone", async () => {
    const run = harness();
    expect(run.redisPrefix).toBe(`rff_test_${run.runId}`);
    const redis = await connectRedis(run.redisUrl);
    const other = `rff_test_${randomBytes(8).toString('hex')}:probe`;
    try {
      const mine = `${run.redisPrefix}:harness:${randomBytes(4).toString('hex')}`;
      await redis.set(`${mine}:a`, '1');
      await redis.set(`${mine}:b`, '2');
      await redis.set(`${mine}x`, 'not under the prefix with its separator');
      await redis.set(other, 'another run');
      expect(await removeKeysWithPrefix(redis, `${mine}:`)).toBe(2);
      expect(await redis.exists([`${mine}:a`, `${mine}:b`])).toBe(0);
      expect(await redis.get(`${mine}x`)).toBe('not under the prefix with its separator');
      expect(await redis.get(other)).toBe('another run');
      await redis.del([`${mine}x`]);
    } finally {
      await redis.del([other]);
      redis.destroy();
    }
  });

  it('a prefix is matched literally, glob characters included', () => {
    expect(escapeGlob('rff_test_0123456789abcdef:')).toBe('rff_test_0123456789abcdef:');
    expect(escapeGlob('a*b?c[d]e\\')).toBe('a\\*b\\?c\\[d\\]e\\\\');
  });

  it('another run gets its own database and prefix, and its teardown removes its databases, roles and keys but nothing of this run', async () => {
    const run = harness();
    let other: HarnessContext | undefined;
    const project = {
      provide: (_key: 'rff', value: HarnessContext) => {
        other = value;
      },
    } as unknown as TestProject;
    const teardown = await setup(project);
    let tornDown = false;
    const redis = await connectRedis(run.redisUrl);
    const server = await connectClient(run.serverAdminUrl, 'rff-test-harness');
    const mine = `${run.redisPrefix}:harness:${randomBytes(4).toString('hex')}`;
    try {
      if (other === undefined) throw new Error('global setup provided no context');
      expect(other.runId).not.toBe(run.runId);
      expect(other.database).toBe(`rff_test_${other.runId}`);
      expect(other.redisPrefix).not.toBe(run.redisPrefix);

      const suffix = randomBytes(3).toString('hex');
      await createDatabase(server, `${other.database}_extra_${suffix}`);
      await server.query(`CREATE ROLE ${ident(`${other.database}_role_${suffix}`)} NOLOGIN`);
      await redis.set(`${other.redisPrefix}:a`, '1');
      await redis.set(`${other.redisPrefix}:b`, '2');
      await redis.set(mine, 'this run');
      expect(await namesUnder(server, other.database)).toEqual({ databases: 2, roles: 1 });

      tornDown = true;
      await teardown();

      expect(await namesUnder(server, other.database)).toEqual({ databases: 0, roles: 0 });
      expect(await redis.exists([`${other.redisPrefix}:a`, `${other.redisPrefix}:b`])).toBe(0);
      expect(await redis.get(mine)).toBe('this run');
      const own = await server.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [
        run.database,
      ]);
      expect(own.rowCount).toBe(1);
    } finally {
      if (!tornDown) await teardown();
      await redis.del([mine]);
      redis.destroy();
      await server.end();
    }
  });

  it('the start-up sweep drops runs that started more than six hours ago and keeps newer and undated ones', async () => {
    const run = harness();
    const hour = 60 * 60 * 1000;
    const ids = { old: runId(), recent: runId(), undated: runId() };
    const server = await connectClient(run.serverAdminUrl, 'rff-test-harness');
    try {
      for (const [age, id] of [
        [7 * hour, ids.old],
        [5 * hour, ids.recent],
      ] as const) {
        const name = `rff_test_${id}`;
        // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
        await createDatabase(server, name);
        const started = new Date(Date.now() - age).toISOString();
        // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
        await server.query(
          `COMMENT ON DATABASE ${ident(name)} IS ${literal(`rff test run started ${started}`)}`,
        );
      }
      await server.query(`CREATE DATABASE ${ident(`rff_test_${ids.undated}`)}`);
      await server.query(`CREATE ROLE ${ident(`rff_test_${ids.old}_role`)} NOLOGIN`);

      const swept = await dropAbandonedRuns(run.serverAdminUrl);

      // Another run that starts now may sweep the old one first, so this checks what is
      // left rather than who dropped it.
      expect(swept).not.toContain(ids.recent);
      expect(swept).not.toContain(ids.undated);
      expect(await namesUnder(server, `rff_test_${ids.old}`)).toEqual({ databases: 0, roles: 0 });
      expect(await namesUnder(server, `rff_test_${ids.recent}`)).toEqual({
        databases: 1,
        roles: 0,
      });
      expect(await namesUnder(server, `rff_test_${ids.undated}`)).toEqual({
        databases: 1,
        roles: 0,
      });
    } finally {
      await server.end();
      await Promise.all(Object.values(ids).map((id) => dropRun(run.serverAdminUrl, id)));
    }
  });
});

function runId(): string {
  return randomBytes(8).toString('hex');
}

/** How many databases and roles are named prefix or prefix_<anything>. */
async function namesUnder(
  server: pg.ClientBase,
  prefix: string,
): Promise<{ databases: number; roles: number }> {
  const like = `${prefix.replaceAll('_', '\\_')}\\_%`;
  const { rows } = await server.query<{ databases: number; roles: number }>(
    `SELECT
       (SELECT count(*)::int FROM pg_catalog.pg_database WHERE datname = $1 OR datname LIKE $2)
         AS databases,
       (SELECT count(*)::int FROM pg_catalog.pg_roles WHERE rolname = $1 OR rolname LIKE $2)
         AS roles`,
    [prefix, like],
  );
  return rows[0] as { databases: number; roles: number };
}
