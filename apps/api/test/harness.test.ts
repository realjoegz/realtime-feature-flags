import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import { connectClient } from '../src/database/connect.js';
import { MIGRATIONS_DIR, readMigrations } from '../src/migrator.js';
import { adminClient, harness, type HarnessContext } from './harness/context.js';
import setup from './harness/global-setup.js';
import { connectRedis, escapeGlob, removeKeysWithPrefix } from './harness/redis.js';
import { RunKeysError, runKeyProblems } from './harness/redis-keys.js';
import { createDatabase, dropAbandonedRuns, dropRun } from './harness/runs.js';
import { ident, literal } from './harness/settings.js';

// The test harness (harness/global-setup.ts) gives each run of the api project its own
// database and Redis prefix, so concurrent runs against the one compose stack do not
// see each other's data.

/** A cache entry as the apps write it, with no flags. */
const entry = (tenantId: string, version: number): string =>
  JSON.stringify({ tenantId, version, flags: [] });

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

  // DROP DATABASE waits for a checkpoint. While other test runs on the server create
  // databases, a checkpoint has many new files to sync: with three runs at once, the
  // teardown here took 41 s.
  it(
    'another run gets its own database and prefix, and its teardown removes its databases, roles and keys but nothing of this run',
    { timeout: 120_000 },
    async () => {
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
        // A probe key of the harness and a cache entry, which the teardown's key check
        // accepts.
        const tenantId = randomUUID();
        const left = [
          `${other.redisPrefix}:harness:a`,
          `${other.redisPrefix}:env-0a1b2c:flags:${tenantId}:v1`,
        ];
        await redis.set(left[0]!, '1');
        await redis.set(left[1]!, entry(tenantId, 1));
        await redis.set(mine, 'this run');
        expect(await namesUnder(server, other.database)).toEqual({ databases: 2, roles: 1 });

        tornDown = true;
        await teardown();

        expect(await namesUnder(server, other.database)).toEqual({ databases: 0, roles: 0 });
        expect(await redis.exists(left)).toBe(0);
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
    },
  );

  it("the teardown's key check reports every key under a run prefix, outside <run>:harness:, that is not <run>:<environment>:flags:<tenant>:v<version> or whose entry names another tenant or version, and accepts cache entries and the harness's probe keys", async () => {
    const run = harness();
    // A run prefix of its own, under this run's probe keys.
    const prefix = `${run.redisPrefix}:harness:${randomBytes(4).toString('hex')}`;
    const redis = await connectRedis(run.redisUrl);
    const tenantId = randomUUID();
    const env = `${prefix}:env-0a1b2c`;
    const keys: Record<string, string> = {
      [`${prefix}:harness:probe`]: '1',
      [`${env}:flags:${tenantId}:v0`]: entry(tenantId, 0),
      [`${env}:flags:${tenantId}:v12`]: entry(tenantId, 12),
      [`${env}:flags:v3`]: entry(tenantId, 3),
      [`${env}:flags:${tenantId}:first`]: entry(tenantId, 3),
      [`${env}:flags:${tenantId}:v03`]: entry(tenantId, 3),
      [`${env}:changes`]: '1',
      [`${prefix}:flags:${tenantId}:v3`]: entry(tenantId, 3),
      [`${env}:flags:${tenantId}:v4`]: entry(randomUUID(), 4),
      [`${env}:flags:${tenantId}:v5`]: entry(tenantId, 6),
      [`${env}:flags:${tenantId}:v6`]: 'not json',
    };
    try {
      for (const [key, value] of Object.entries(keys)) {
        // eslint-disable-next-line no-await-in-loop -- one key after another
        await redis.set(key, value);
      }
      const problems = await runKeyProblems(redis, prefix);
      const shape = 'is not <run>:<environment>:flags:<tenant>:v<version>';
      const entryProblem = 'does not hold a snapshot of that tenant and version';
      expect(problems).toEqual(
        [
          `${env}:flags:v3 ${shape}`,
          `${env}:flags:${tenantId}:first ${shape}`,
          `${env}:flags:${tenantId}:v03 ${shape}`,
          `${env}:changes ${shape}`,
          `${prefix}:flags:${tenantId}:v3 ${shape}`,
          `${env}:flags:${tenantId}:v4 ${entryProblem}`,
          `${env}:flags:${tenantId}:v5 ${entryProblem}`,
          `${env}:flags:${tenantId}:v6 ${entryProblem}`,
        ].toSorted(),
      );
      expect(new RunKeysError(prefix, problems).message).toBe(
        `At the end of the run, 8 Redis keys under ${prefix} are not tenant-scoped cache entries:\n  ${problems.join('\n  ')}`,
      );
      expect(await runKeyProblems(redis, `${prefix}x`)).toEqual([]);
    } finally {
      await removeKeysWithPrefix(redis, `${prefix}:`);
      redis.destroy();
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
