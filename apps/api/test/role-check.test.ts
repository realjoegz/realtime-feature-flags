import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Config } from '../src/config.js';
import { connectClient } from '../src/database/connect.js';
import { inspectRole, PrivilegedRoleError } from '../src/database/role-check.js';
import {
  createScratchDatabase,
  createScratchGroup,
  createScratchRole,
  harness,
  type ScratchDatabase,
  type ScratchRole,
} from './harness/context.js';
import { ident } from './harness/settings.js';

// The API refuses to start as a role that row-level security does not bind. Each case
// connects as a role with one such privilege to a scratch database and reads the
// report that start-up acts on; the last case goes through createApp itself. The
// global teardown drops the scratch roles and databases with the rest of the run.

let scratch: ScratchDatabase;
let bypass: ScratchRole;
let tableOwner: ScratchRole;
let ownerMember: ScratchRole;
let schemaOwner: ScratchRole;
let databaseOwner: ScratchRole;
let ownedDatabase: ScratchDatabase;
let plain: ScratchRole;
let bypassMember: ScratchRole;
let superMember: ScratchRole;
let databaseOwnerMember: ScratchRole;
let bypassGroup: string;
let superGroup: string;
// One owner for each kind of relation besides a plain table.
const relations = [
  { name: 'owned_parted', kind: 'TABLE', definition: '(id integer) PARTITION BY RANGE (id)' },
  { name: 'owned_view', kind: 'VIEW', definition: 'AS SELECT 1 AS one' },
  { name: 'owned_matview', kind: 'MATERIALIZED VIEW', definition: 'AS SELECT 1 AS one' },
  { name: 'owned_sequence', kind: 'SEQUENCE', definition: '' },
] as const;
let relationOwners: ScratchRole[];
let temporaryHolder: ScratchRole;

beforeAll(async () => {
  scratch = await createScratchDatabase('rolecheck');
  [bypass, tableOwner, ownerMember, schemaOwner, databaseOwner, plain] = await Promise.all([
    createScratchRole('bypass', 'BYPASSRLS'),
    createScratchRole('tableowner'),
    createScratchRole('ownermember'),
    createScratchRole('schemaowner'),
    createScratchRole('dbowner'),
    createScratchRole('plain'),
  ]);
  [bypassMember, superMember, databaseOwnerMember, temporaryHolder, ...relationOwners] =
    await Promise.all([
      createScratchRole('bypassmember'),
      createScratchRole('supermember'),
      createScratchRole('dbownermember'),
      createScratchRole('temporary'),
      ...relations.map((_, index) => createScratchRole(`relationowner${index}`)),
    ]);
  [bypassGroup, superGroup] = await Promise.all([
    createScratchGroup('bypassgroup', 'BYPASSRLS'),
    createScratchGroup('supergroup', 'SUPERUSER'),
  ]);
  ownedDatabase = await createScratchDatabase('owned');
  const admin = await connectClient(scratch.adminUrl, 'rff-test-rolecheck');
  try {
    await admin.query('CREATE TABLE owned_table (id integer)');
    await admin.query(`ALTER TABLE owned_table OWNER TO ${ident(tableOwner.name)}`);
    await admin.query(`GRANT ${ident(tableOwner.name)} TO ${ident(ownerMember.name)}`);
    await admin.query(`CREATE SCHEMA owned_schema AUTHORIZATION ${ident(schemaOwner.name)}`);
    await admin.query(
      `ALTER DATABASE ${ident(ownedDatabase.name)} OWNER TO ${ident(databaseOwner.name)}`,
    );
    await admin.query(`GRANT ${ident(bypassGroup)} TO ${ident(bypassMember.name)}`);
    await admin.query(`GRANT ${ident(superGroup)} TO ${ident(superMember.name)}`);
    await admin.query(`GRANT ${ident(databaseOwner.name)} TO ${ident(databaseOwnerMember.name)}`);
    for (const [index, { name, kind, definition }] of relations.entries()) {
      const owner = (relationOwners[index] as ScratchRole).name;
      // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
      await admin.query(`CREATE ${kind} ${name} ${definition}`);
      // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
      await admin.query(`ALTER ${kind} ${name} OWNER TO ${ident(owner)}`);
    }
  } finally {
    await admin.end();
  }
});

async function reportFor(url: string): Promise<{ role: string; problems: readonly string[] }> {
  const client = await connectClient(url, 'rff-test-rolecheck');
  try {
    return await inspectRole(client);
  } finally {
    await client.end();
  }
}

function configFor(url: string): Config {
  return {
    http: { host: '127.0.0.1', port: 0 },
    instance: 'role-check',
    database: { url, poolMax: 2, connectDeadlineMs: 5000 },
  };
}

describe('start-up refuses a privileged database role', () => {
  it('rff_app on a migrated database has no privilege that skips row-level security', async () => {
    expect(await reportFor(harness().appUrl)).toEqual({ role: 'rff_app', problems: [] });
  });

  it('a plain login role on the same scratch database has none either', async () => {
    expect(await reportFor(scratch.urlFor(plain))).toEqual({ role: plain.name, problems: [] });
  });

  it('a superuser is refused', async () => {
    const report = await reportFor(scratch.adminUrl);
    expect(report.problems).toContain('is a superuser');
    expect(report.problems).toContain('has BYPASSRLS');
  });

  it('a role with BYPASSRLS is refused', async () => {
    expect((await reportFor(scratch.urlFor(bypass))).problems).toEqual(['has BYPASSRLS']);
  });

  it('a role that owns a table is refused', async () => {
    expect((await reportFor(scratch.urlFor(tableOwner))).problems).toEqual([
      'owns tables, views or sequences public.owned_table',
    ]);
  });

  it('a member of a role that owns a table or the database is refused', async () => {
    expect((await reportFor(scratch.urlFor(ownerMember))).problems).toEqual([
      'owns tables, views or sequences public.owned_table',
    ]);
    expect((await reportFor(ownedDatabase.urlFor(databaseOwnerMember))).problems).toEqual([
      `owns the database ${ownedDatabase.name}`,
      'owns schemas public',
    ]);
  });

  it('a member of a role with BYPASSRLS is refused', async () => {
    expect((await reportFor(scratch.urlFor(bypassMember))).problems).toEqual([
      `is a member of superuser or BYPASSRLS roles ${bypassGroup}`,
    ]);
  });

  it('a member of a superuser role is refused', async () => {
    expect((await reportFor(scratch.urlFor(superMember))).problems).toEqual([
      `is a member of superuser or BYPASSRLS roles ${superGroup}`,
    ]);
  });

  it('a role that owns a partitioned table, a view, a materialized view or a sequence is refused', async () => {
    const reports = await Promise.all(
      relationOwners.map((role) => reportFor(scratch.urlFor(role))),
    );
    expect(reports.map((report) => report.problems)).toEqual(
      relations.map(({ name }) => [`owns tables, views or sequences public.${name}`]),
    );
  });

  it('a temporary table that the role holds in another session does not block start-up', async () => {
    const holder = await connectClient(scratch.urlFor(temporaryHolder), 'rff-test-rolecheck');
    try {
      await holder.query('CREATE TEMPORARY TABLE held (id integer)');
      const { rows } = await holder.query<{ owner: string }>(
        `SELECT pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class
         WHERE oid = 'pg_temp.held'::regclass`,
      );
      expect(rows).toEqual([{ owner: temporaryHolder.name }]);
      expect(await reportFor(scratch.urlFor(temporaryHolder))).toEqual({
        role: temporaryHolder.name,
        problems: [],
      });
    } finally {
      await holder.end();
    }
  });

  it('a role that owns a schema or the database is refused', async () => {
    expect((await reportFor(scratch.urlFor(schemaOwner))).problems).toEqual([
      'owns schemas owned_schema',
    ]);
    expect((await reportFor(ownedDatabase.urlFor(databaseOwner))).problems).toEqual([
      `owns the database ${ownedDatabase.name}`,
      'owns schemas public',
    ]);
  });

  it('createApp rejects a superuser, a BYPASSRLS role, a table owner and a member of a superuser role, and starts as rff_app', async () => {
    const urls = [
      scratch.adminUrl,
      scratch.urlFor(bypass),
      scratch.urlFor(tableOwner),
      scratch.urlFor(superMember),
    ];
    const failures = await Promise.all(
      urls.map((url) =>
        createApp(configFor(url), { logger: false }).then(
          () => new Error('createApp resolved'),
          (error: unknown) => error,
        ),
      ),
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(PrivilegedRoleError);
      expect((failure as Error).message).toMatch(/^refusing to start: database role "/);
    }
    const app = await createApp(configFor(harness().appUrl), { logger: false });
    await app.close();
  });
});
