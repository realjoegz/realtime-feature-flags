import type pg from 'pg';
import { connectClient } from '../../src/database/connect.js';
import { ident, literal } from './settings.js';

// Everything a test run creates on the shared server is named rff_test_<run id>,
// optionally followed by _<label>: the run's database, scratch databases and scratch
// roles. Teardown drops by that prefix, and the next run drops what a killed run left.

export const RUN_ID = /^[0-9a-f]{16}$/;
const STARTED = /^rff test run started (\S+)$/;
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

export function runPrefix(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`not a run id: ${runId}`);
  return `rff_test_${runId}`;
}

/** A LIKE pattern for the names under a run prefix. */
function underscoreLike(prefix: string): string {
  return `${prefix.replaceAll('_', '\\_')}\\_%`;
}

export async function createDatabase(admin: pg.ClientBase, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  await admin.query(
    `COMMENT ON DATABASE ${ident(name)} IS ${literal(`rff test run started ${new Date().toISOString()}`)}`,
  );
}

/** Drops the run's databases (closing their connections), then its roles. */
export async function dropRun(serverAdminUrl: string, runId: string): Promise<string[]> {
  const prefix = runPrefix(runId);
  const problems: string[] = [];
  const admin = await connectClient(serverAdminUrl, 'rff-test-teardown');
  try {
    const databases = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_catalog.pg_database WHERE datname = $1 OR datname LIKE $2',
      [prefix, underscoreLike(prefix)],
    );
    // One statement at a time: pg 8 deprecates sending a query on a client that is
    // still running one.
    for (const { datname } of databases.rows) {
      // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
      await admin.query(`DROP DATABASE IF EXISTS ${ident(datname)} WITH (FORCE)`);
    }
    const roles = await admin.query<{ rolname: string }>(
      'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE $1',
      [underscoreLike(prefix)],
    );
    for (const { rolname } of roles.rows) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
        await admin.query(`DROP ROLE IF EXISTS ${ident(rolname)}`);
      } catch (error) {
        problems.push(`role ${rolname}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await admin.end();
  }
  return problems;
}

/** Drops the leftovers of runs that started more than six hours ago. */
export async function dropAbandonedRuns(
  serverAdminUrl: string,
  now = Date.now(),
): Promise<string[]> {
  const admin = await connectClient(serverAdminUrl, 'rff-test-sweep');
  let stale: string[];
  try {
    const { rows } = await admin.query<{ datname: string; comment: string | null }>(
      `SELECT datname, pg_catalog.shobj_description(oid, 'pg_database') AS comment
       FROM pg_catalog.pg_database WHERE datname ~ '^rff_test_[0-9a-f]{16}$'`,
    );
    stale = rows
      .filter(({ comment }) => {
        const started = STARTED.exec(comment ?? '')?.[1];
        return started !== undefined && now - Date.parse(started) > ABANDONED_AFTER_MS;
      })
      .map(({ datname }) => datname.slice('rff_test_'.length));
  } finally {
    await admin.end();
  }
  await Promise.all(stale.map((runId) => dropRun(serverAdminUrl, runId)));
  return stale;
}
