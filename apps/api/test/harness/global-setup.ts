import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { connectClient } from '../../src/database/connect.js';
import { withConnectRetry } from '../../src/database/retry.js';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../../src/migrator.js';
import type { HarnessContext } from './context.js';
import { connectRedis, removeKeysWithPrefix } from './redis.js';
import { RunKeysError, runKeyProblems } from './redis-keys.js';
import { createDatabase, dropAbandonedRuns, dropRun, runPrefix } from './runs.js';
import { harnessSettings, withCredentials, withDatabase } from './settings.js';
import { SharedRolesChangedError, sharedRoleProblems } from './shared-roles.js';

// Runs once per test run of the api project, before any test file. Each run gets
// its own database, built by the real migration runner from apps/api/migrations, and
// its own Redis key and channel prefix, so concurrent runs on one machine (CI, a
// second checkout) share the servers but not each other's databases or keys. The
// roles rff_app and rff_owner are the exception: they belong to the whole Postgres
// server (see shared-roles.ts).

const START_HINT = 'start it with: docker compose up --detach --wait postgres redis';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const settings = harnessSettings(process.env);
  const runId = randomBytes(8).toString('hex');
  const prefix = runPrefix(runId);

  const server = await reach('Postgres', settings.serverAdminUrl, () =>
    withConnectRetry(() => connectClient(settings.serverAdminUrl, 'rff-test-setup'), {
      deadlineMs: 15_000,
    }),
  );
  await server.end();
  await dropAbandonedRuns(settings.serverAdminUrl);

  const redis = await reach('Redis', settings.redisUrl, () => connectRedis(settings.redisUrl));
  redis.destroy();

  const adminUrl = withDatabase(settings.serverAdminUrl, prefix);
  const appUrl = withCredentials(adminUrl, 'rff_app', settings.appPassword);

  const removeRun = async (): Promise<void> => {
    const problems = await dropRun(settings.serverAdminUrl, runId);
    for (const problem of problems) console.warn(`test teardown: ${problem}`);
    const client = await connectRedis(settings.redisUrl);
    try {
      await removeKeysWithPrefix(client, `${prefix}:`);
    } finally {
      client.destroy();
    }
  };

  try {
    const admin = await connectClient(settings.serverAdminUrl, 'rff-test-setup');
    try {
      await createDatabase(admin, prefix);
    } finally {
      await admin.end();
    }
    const migrator = await connectClient(adminUrl, 'rff-test-setup');
    try {
      await migrate(migrator, await readMigrations(MIGRATIONS_DIR), {
        settings: { 'rff.app_password': settings.appPassword },
      });
    } finally {
      await migrator.end();
    }
    const problems = await sharedRoleProblems(adminUrl, appUrl);
    if (problems.length > 0) throw new SharedRolesChangedError('After the migrations', problems);
    const context: HarnessContext = {
      runId,
      database: prefix,
      serverAdminUrl: settings.serverAdminUrl,
      adminUrl,
      appUrl,
      redisUrl: settings.redisUrl,
      redisPrefix: prefix,
    };
    project.provide('rff', context);
  } catch (error) {
    await removeRun();
    throw error;
  }

  // Checks the shared roles once more while the run's database still exists, and
  // every key the run left in Redis (redis-keys.ts), then removes the run. It fails
  // the run if the roles changed while it ran or a key is not a tenant-scoped entry.
  return async (): Promise<void> => {
    let problems: string[];
    let keyProblems: string[];
    try {
      problems = await sharedRoleProblems(adminUrl, appUrl);
      const client = await connectRedis(settings.redisUrl);
      try {
        keyProblems = await runKeyProblems(client, prefix);
      } finally {
        client.destroy();
      }
    } finally {
      await removeRun();
    }
    if (problems.length > 0) throw new SharedRolesChangedError('At the end of the run', problems);
    if (keyProblems.length > 0) throw new RunKeysError(prefix, keyProblems);
  };
}

async function reach<T>(what: string, url: string, connect: () => Promise<T>): Promise<T> {
  try {
    return await connect();
  } catch (error) {
    const where = new URL(url).host;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} is not reachable at ${where} (${message}); ${START_HINT}`, {
      cause: error,
    });
  }
}
