import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../src/migrator.js';
import { adminClient, createScratchDatabase, harness } from './harness/context.js';
import { harnessSettings } from './harness/settings.js';

// Migration 0001 creates the cluster-wide roles. Every test run applies it to its own
// new database while the roles already exist, which is the idempotent path.
//
// Other runs on the same server share rff_app and rff_owner, so the cases that change
// them do it inside a transaction that they roll back: 0001 locks pg_authid first, no
// other session can commit a role change until the rollback, and none ever sees the
// changes made inside it.

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

const ROLES = `
  SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
  FROM pg_catalog.pg_roles WHERE rolname IN ('rff_owner', 'rff_app') ORDER BY rolname`;

async function roles(): Promise<RoleRow[]> {
  const admin = await adminClient();
  try {
    return (await admin.query<RoleRow>(ROLES)).rows;
  } finally {
    await admin.end();
  }
}

const unprivileged = {
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
};

/** The two roles as 0001 leaves them. */
const asMigrated: RoleRow[] = [
  { rolname: 'rff_app', rolcanlogin: true, ...unprivileged },
  { rolname: 'rff_owner', rolcanlogin: false, ...unprivileged },
];

const appPassword = harnessSettings(process.env).appPassword;

/**
 * Runs the statements in before, then migration 0001 with password as its
 * rff.app_password setting, then read, all in one transaction that is rolled back.
 */
async function rolledBack0001<T>(
  password: string,
  before: readonly string[],
  read: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  const roles0001 = (await readMigrations(MIGRATIONS_DIR)).find((m) => m.version === 1);
  if (roles0001 === undefined) throw new Error('no migration 0001');
  const admin = await adminClient();
  try {
    await admin.query('BEGIN');
    try {
      await admin.query('LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE');
      for (const statement of before) {
        // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
        await admin.query(statement);
      }
      await admin.query(`SELECT pg_catalog.set_config('rff.app_password', $1, true)`, [password]);
      await admin.query(roles0001.sql);
      return await read(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  } finally {
    await admin.end();
  }
}

/**
 * Whether a SCRAM-SHA-256 verifier from pg_authid.rolpassword was made from password
 * (RFC 5802 and RFC 7677). The passwords here are ASCII, which SASLprep leaves as is.
 */
function verifierMatches(verifier: string, password: string): boolean {
  const parts = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (parts === null) return false;
  const [, iterations = '', salt = '', storedKey, serverKey] = parts;
  const salted = pbkdf2Sync(
    password,
    Buffer.from(salt, 'base64'),
    Number(iterations),
    32,
    'sha256',
  );
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  return (
    createHash('sha256').update(clientKey).digest('base64') === storedKey &&
    createHmac('sha256', salted).update('Server Key').digest('base64') === serverKey
  );
}

describe('migration 0001: roles', () => {
  it('creates rff_owner without login and rff_app with login, neither superuser nor BYPASSRLS', async () => {
    expect(await roles()).toEqual(asMigrated);
  });

  it("rff_app logs in to this run's database with the harness app password", async () => {
    const app = await connectClient(harness().appUrl, 'rff-test-roles');
    try {
      const { rows } = await app.query('SELECT current_user AS role, current_database() AS db');
      expect(rows).toEqual([{ role: 'rff_app', db: harness().database }]);
    } finally {
      await app.end();
    }
  });

  it("sets rff_app's password from the rff.app_password setting it runs with", async () => {
    const password = randomBytes(12).toString('hex');
    const verifier = await rolledBack0001(password, [], async (client) => {
      const { rows } = await client.query<{ rolpassword: string }>(
        `SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = 'rff_app'`,
      );
      return rows[0]?.rolpassword ?? '';
    });
    expect(verifier).toMatch(/^SCRAM-SHA-256\$/);
    expect(verifierMatches(verifier, password)).toBe(true);
    // Control: the same check rejects another password.
    expect(verifierMatches(verifier, `${password}x`)).toBe(false);
  });

  it('sets the attributes of roles that already exist, also after they were changed', async () => {
    const drift = 'SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION';
    const after = await rolledBack0001(
      appPassword,
      [`ALTER ROLE rff_owner LOGIN ${drift}`, `ALTER ROLE rff_app NOLOGIN ${drift}`],
      async (client) => (await client.query<RoleRow>(ROLES)).rows,
    );
    expect(after).toEqual(asMigrated);
    // The rollback leaves the shared roles as they were.
    expect(await roles()).toEqual(asMigrated);
  });

  it('applies on four new databases at once while the roles already exist', async () => {
    const migrations = await readMigrations(MIGRATIONS_DIR);
    const databases = await Promise.all(
      ['ra', 'rb', 'rc', 'rd'].map((label) => createScratchDatabase(`roles${label}`)),
    );
    const results = await Promise.all(
      databases.map(async (database) => {
        const client = await connectClient(database.adminUrl, 'rff-test-roles');
        try {
          return await migrate(client, migrations, {
            settings: { 'rff.app_password': appPassword },
          });
        } finally {
          await client.end();
        }
      }),
    );
    expect(results.map((r) => r.applied.map((m) => m.file))).toEqual(
      databases.map(() => migrations.map((m) => m.file)),
    );
    expect(await roles()).toEqual(asMigrated);
  });

  it('fails, and records nothing, when the runner passes no app password', async () => {
    const database = await createScratchDatabase('rolesnopw');
    const client = await connectClient(database.adminUrl, 'rff-test-roles');
    try {
      await expect(migrate(client, await readMigrations(MIGRATIONS_DIR))).rejects.toThrow(
        '0001_roles.sql failed and was rolled back: rff.app_password is not set',
      );
      const { rows } = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
      expect(rows).toEqual([{ n: 0 }]);
    } finally {
      await client.end();
    }
  });
});
