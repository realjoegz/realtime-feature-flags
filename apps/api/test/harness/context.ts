import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { inject } from 'vitest';
import { connectClient } from '../../src/database/connect.js';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../../src/migrator.js';
import { createDatabase } from './runs.js';
import { harnessSettings, ident, literal, withCredentials, withDatabase } from './settings.js';

/** What global-setup.ts provides to every test file of the api project. */
export interface HarnessContext {
  /** 16 hex digits, new for each run. */
  readonly runId: string;
  /** rff_test_<runId>: this run's database, migrated from apps/api/migrations. */
  readonly database: string;
  /** Superuser on the maintenance database, for CREATE and DROP DATABASE. */
  readonly serverAdminUrl: string;
  /** Superuser on this run's database. It bypasses row-level security. */
  readonly adminUrl: string;
  /** rff_app on this run's database: the role the API connects as. */
  readonly appUrl: string;
  readonly redisUrl: string;
  /** rff_test_<runId>: every Redis key and channel of this run starts with it and ":". */
  readonly redisPrefix: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    rff: HarnessContext;
  }
}

export function harness(): HarnessContext {
  return inject('rff');
}

/** A connected superuser client on this run's database, or on another one. */
export function adminClient(database?: string): Promise<pg.Client> {
  const run = harness();
  const url = database === undefined ? run.adminUrl : withDatabase(run.adminUrl, database);
  return connectClient(url, 'rff-test-admin');
}

export interface ScratchDatabase {
  readonly name: string;
  readonly adminUrl: string;
  urlFor(role: ScratchRole | { name: string; password: string }): string;
}

export interface ScratchRole {
  readonly name: string;
  readonly password: string;
}

/**
 * An empty database next to this run's one, named rff_test_<runId>_<label>_<random>.
 * Global teardown drops it with the run.
 */
export async function createScratchDatabase(label: string): Promise<ScratchDatabase> {
  const run = harness();
  const name = scratchName(run, label);
  const server = await connectClient(run.serverAdminUrl, 'rff-test-admin');
  try {
    await createDatabase(server, name);
  } finally {
    await server.end();
  }
  const adminUrl = withDatabase(run.serverAdminUrl, name);
  return {
    name,
    adminUrl,
    urlFor: (role) => withCredentials(adminUrl, role.name, role.password),
  };
}

export interface MigratedDatabase extends ScratchDatabase {
  /** rff_app on this database. */
  readonly appUrl: string;
}

/**
 * A scratch database with every migration in apps/api/migrations applied by the
 * migration runner, like this run's own database. For tests that empty and refill
 * the tenant tables, which other test files share in the run's database.
 */
export async function createMigratedDatabase(label: string): Promise<MigratedDatabase> {
  const scratch = await createScratchDatabase(label);
  const { appPassword } = harnessSettings(process.env);
  const client = await connectClient(scratch.adminUrl, 'rff-test-migrate');
  try {
    await migrate(client, await readMigrations(MIGRATIONS_DIR), {
      settings: { 'rff.app_password': appPassword },
    });
  } finally {
    await client.end();
  }
  return { ...scratch, appUrl: scratch.urlFor({ name: 'rff_app', password: appPassword }) };
}

/**
 * A role that can log in, named rff_test_<runId>_<label>_<random>, with extra
 * attributes such as 'BYPASSRLS'. Roles are server-wide; global teardown drops it.
 */
export async function createScratchRole(label: string, attributes = ''): Promise<ScratchRole> {
  const run = harness();
  const role = { name: scratchName(run, label), password: randomBytes(12).toString('hex') };
  const admin = await connectClient(run.serverAdminUrl, 'rff-test-admin');
  try {
    await admin.query(
      `CREATE ROLE ${ident(role.name)} LOGIN ${attributes} PASSWORD ${literal(role.password)}`,
    );
  } finally {
    await admin.end();
  }
  return role;
}

/**
 * A role that cannot log in, named like a scratch role, with extra attributes such
 * as 'SUPERUSER'. Other roles become its members with GRANT. Global teardown drops it.
 */
export async function createScratchGroup(label: string, attributes = ''): Promise<string> {
  const run = harness();
  const name = scratchName(run, label);
  const admin = await connectClient(run.serverAdminUrl, 'rff-test-admin');
  try {
    await admin.query(`CREATE ROLE ${ident(name)} NOLOGIN ${attributes}`);
  } finally {
    await admin.end();
  }
  return name;
}

function scratchName(run: HarnessContext, label: string): string {
  if (!/^[a-z0-9]{1,24}$/.test(label)) {
    throw new Error(`scratch label must be [a-z0-9]{1,24}: ${label}`);
  }
  return `${run.database}_${label}_${randomBytes(3).toString('hex')}`;
}
