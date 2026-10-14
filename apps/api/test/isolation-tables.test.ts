import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { createPool } from '../src/database/pool.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import {
  createMigratedDatabase,
  createScratchDatabase,
  createScratchGroup,
  createScratchRole,
  type MigratedDatabase,
} from './harness/context.js';
import { ident, literal } from './harness/settings.js';
import {
  definerFunctions,
  reachableRelations,
  RELATION_ALLOW_LIST,
  relationExists,
  type Relation,
} from './isolation/catalogue.js';
import {
  type AllowedDefiner,
  canaryFindings,
  crossTenantWriteFindings,
  definerFindings,
  type Finding,
  inSequence,
  lookupFindings,
  noTenantFindings,
  privilegeFindings,
  relationsWithFindings,
  rowSecurityFindings,
  seedFindings,
  selectFindings,
  type Subject,
  writeFindings,
} from './isolation/detectors.js';
import {
  createFixture,
  type Fixture,
  type Scope,
  type TenancyRule,
  tenancyRule,
  uuidLiteral,
} from './isolation/fixture.js';
import {
  DEFINER_ALLOW_LIST,
  KEY_LOOKUP,
  lookupCases,
  MEMBERSHIPS_LOOKUP,
  ROLE_LOOKUP,
  settingValues,
  USER_LOOKUP,
} from './isolation/lookups.js';

// Tenant isolation at the database, checked table by table. The tables come from
// the catalogue: every relation rff_app holds a privilege on. The fixture fills them
// for tenants A and B (isolation/fixture.ts), and each check acts in B's context and
// must not reach A. The run's own database is shared with other test files, so this
// file migrates a database of its own, where it can empty and refill the tables.

const TENANT_TABLES = [
  'public.audit_log',
  'public.flags',
  'public.memberships',
  'public.sdk_keys',
  'public.tenants',
  'public.users',
];

let database: MigratedDatabase;
let admin: pg.Client;
let fixture: Fixture;
let relations: readonly Relation[];
let allowListed: readonly string[];

/** The detectors' view of a role on this file's database. */
function subjectFor(role: string, url: string): Subject {
  return {
    admin,
    role,
    url,
    relations,
    rule: (relation) => tenancyRule(relation),
    contexts: fixture.contexts,
    reseed: () => fixture.seed(admin),
  };
}

const asApp = (): Subject => subjectFor('rff_app', database.appUrl);
const asSuperuser = (): Subject => subjectFor(userOf(database.adminUrl), database.adminUrl);

beforeAll(async () => {
  database = await createMigratedDatabase('isolation');
  admin = await connectClient(database.adminUrl, 'rff-test-isolation');
  fixture = createFixture();
  await fixture.seed(admin);
  ({ relations, allowListed } = await reachableRelations(admin, 'rff_app'));
});

afterAll(async () => {
  await admin?.end();
});

// Some checks commit changes in B and some controls change A; every test starts
// from the seeded rows.
beforeEach(async () => {
  await fixture.seed(admin);
});

function describeFindings(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.relation}: ${finding.detail}`);
}

const silent = { log: () => {}, warn: () => {}, error: () => {} };

/** Each row of users and memberships as text, by its key, on the superuser connection. */
async function usersAndMemberships(): Promise<Map<string, string>> {
  const { rows } = await admin.query<{ key: string; row: string }>(
    `SELECT 'users ' || id AS key, u::text AS row FROM public.users u
     UNION ALL
     SELECT 'memberships ' || tenant_id || ' ' || user_id, m::text FROM public.memberships m`,
  );
  return new Map(rows.map(({ key, row }) => [key, row]));
}

/** The username of a connection URL. */
function userOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

/** SQL that is true for the scope user's rows (alias t) in the scope's tenant. */
function ownRowsIn(scope: Scope): string {
  return `t.tenant_id = ${uuidLiteral(scope.tenantId)} AND t.user_id = ${uuidLiteral(scope.userId)}`;
}

describe('tenant isolation in the tables', () => {
  it('the universe is every table, view, partition and sequence that rff_app holds a privilege on outside the system schemas, minus public.schema_migrations', async () => {
    // The six tables of migration 0002 and nothing else: no view, partition or
    // sequence, since audit_log's id is an identity column.
    expect(relations.map((relation) => relation.name)).toEqual(TENANT_TABLES);
    expect(relations.map((relation) => relation.kind)).toEqual(TENANT_TABLES.map(() => 'r'));
    expect(Object.keys(RELATION_ALLOW_LIST)).toEqual(['public.schema_migrations']);
    // The allow-list names a relation that exists, and rff_app reaches none of it.
    expect(await relationExists(admin, 'public.schema_migrations')).toBe(true);
    expect(allowListed).toEqual([]);
  });

  it('every table in the universe has row-level security enabled and forced', () => {
    expect(describeFindings(rowSecurityFindings(relations))).toEqual([]);
  });

  it('A and B each have rows in every table, and every text and JSON column holds a canary of A in a row that B cannot see', async () => {
    const subject = asApp();
    expect(describeFindings(await seedFindings(subject))).toEqual([]);
    expect(describeFindings(await canaryFindings(subject, fixture.canaries))).toEqual([]);
    // The check covers columns, not only tables: 13 free-text columns today.
    const freeText = relations.flatMap((relation) =>
      relation.columns
        .filter((column) => column.freeText)
        .map((column) => `${relation.name}.${column.name}`),
    );
    expect(freeText.toSorted()).toEqual([...fixture.canaries.keys()].toSorted());
    expect(freeText).toHaveLength(13);
  });

  it("A and B have flags with the same keys and different values, and in B's context a read by key returns B's flags only", async () => {
    // A check that filtered by flag key alone would find A's flag under the same key.
    const { rows: pairs } = await admin.query<{ key: string; enabled: boolean; rollout: boolean }>(
      `SELECT a.key, a.enabled <> b.enabled AS enabled, a.rollout_bp <> b.rollout_bp AS rollout
       FROM public.flags a JOIN public.flags b ON b.key = a.key
       WHERE a.tenant_id = $1 AND b.tenant_id = $2
       ORDER BY a.key`,
      [fixture.tenantA, fixture.tenantB],
    );
    expect(pairs).toEqual([
      { key: 'checkout', enabled: true, rollout: true },
      { key: 'search', enabled: true, rollout: true },
    ]);
    const keys = pairs.map((pair) => pair.key);
    const byKey = 'SELECT key, enabled, rollout_bp FROM public.flags WHERE key = ANY($1)';
    const { rows: ofB } = await admin.query(`${byKey} AND tenant_id = $2 ORDER BY key`, [
      keys,
      fixture.tenantB,
    ]);
    const pool = createPool({ url: database.appUrl, poolMax: 1, connectDeadlineMs: 0 }, silent);
    try {
      const read = await new TenantDatabase(pool).withTenant(fixture.contexts.B, async (client) => {
        return (await client.query(`${byKey} ORDER BY key`, [keys])).rows;
      });
      expect(read).toEqual(ofB);
      expect(read).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });

  it("in B's context rff_app reads exactly B's rows from every table", async () => {
    expect(describeFindings(await selectFindings(asApp()))).toEqual([]);
  });

  it("in B's context an unfiltered UPDATE and an unfiltered DELETE by rff_app change no row outside B, and reach exactly B's rows, or the narrower reach of the command's own policy, where rff_app holds the privilege", async () => {
    expect(describeFindings(await writeFindings(asApp()))).toEqual([]);
    // Two commands have a reach of their own (migration 0004), and rff_app holds the
    // privilege for both, so the check above ran them and compared their rows.
    const own = relations.flatMap((relation) =>
      (['UPDATE', 'DELETE'] as const)
        .filter((command) => tenancyRule(relation)?.reach?.[command] !== undefined)
        .map((command) => `${command} ${relation.name}`),
    );
    expect(own).toEqual(['DELETE public.memberships', 'UPDATE public.users']);
  });

  it("per-command reach: rff_app's UPDATE of users reaches only the current user's row, and only to set its issuer, subject, email and name to NULL; its DELETE on memberships reaches only the current user's membership in the current tenant; with no tenant set the UPDATE still reaches the current user's row and the DELETE nothing", async () => {
    const { shared, aEditor, aViewer, bEditor, nobody } = fixture.users;
    const { tenantA: A, tenantB: B } = fixture;
    const names = new Map([
      [shared.id, 'shared'],
      [aEditor.id, "A's editor"],
      [aViewer.id, "A's viewer"],
      [bEditor.id, "B's editor"],
      [nobody.id, 'nobody'],
      [A, 'A'],
      [B, 'B'],
    ]);
    const erase =
      'UPDATE public.users SET idp_issuer = NULL, idp_subject = NULL, email = NULL, name = NULL';
    const cases: {
      label: string;
      tenant: string | null;
      user: string | null;
      sql: string;
      params?: unknown[];
    }[] = [
      {
        label: 'erase every user, in B as the shared user',
        tenant: B,
        user: shared.id,
        sql: erase,
      },
      {
        label: "erase the shared user, in A as A's viewer, who sees that row",
        tenant: A,
        user: aViewer.id,
        sql: `${erase} WHERE id = $1`,
        params: [shared.id],
      },
      {
        label: 'erase every user, with no tenant set, as nobody',
        tenant: null,
        user: nobody.id,
        sql: erase,
      },
      { label: 'erase every user, in B with no user set', tenant: B, user: null, sql: erase },
      {
        label: "set every user's email, in B as the shared user",
        tenant: B,
        user: shared.id,
        sql: "UPDATE public.users SET email = 'x@example.test'",
      },
      {
        label: 'delete every membership, in B as the shared user',
        tenant: B,
        user: shared.id,
        sql: 'DELETE FROM public.memberships',
      },
      {
        label: "delete A's viewer's membership, in A as the shared user, A's owner",
        tenant: A,
        user: shared.id,
        sql: 'DELETE FROM public.memberships WHERE user_id = $1',
        params: [aViewer.id],
      },
      {
        label: 'delete every membership, with no tenant set, as the shared user',
        tenant: null,
        user: shared.id,
        sql: 'DELETE FROM public.memberships',
      },
      {
        label: 'delete every membership, in B with no user set',
        tenant: B,
        user: null,
        sql: 'DELETE FROM public.memberships',
      },
    ];
    const app = await connectClient(database.appUrl, 'rff-test-isolation');
    try {
      const outcomes = await inSequence(cases, async ({ label, tenant, user, sql, params }) => {
        await fixture.seed(admin);
        const before = await usersAndMemberships();
        await app.query('BEGIN');
        await app.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
          [tenant ?? '', user ?? ''],
        );
        let refusal: string | undefined;
        try {
          await app.query(sql, params);
          await app.query('COMMIT');
        } catch (error) {
          await app.query('ROLLBACK');
          const { code, message } = error as { code?: string; message: string };
          refusal = `${code}: ${message}`;
        }
        const after = await usersAndMemberships();
        const reached = [...before]
          .filter(([key, row]) => after.get(key) !== row)
          .map(([key]) =>
            key
              .split(' ')
              .map((part) => names.get(part) ?? part)
              .join(' '),
          );
        return `${label}: ${refusal ?? `reached [${reached.join(', ')}]`}`;
      });
      expect(outcomes).toEqual([
        'erase every user, in B as the shared user: reached [users shared]',
        "erase the shared user, in A as A's viewer, who sees that row: reached []",
        'erase every user, with no tenant set, as nobody: reached [users nobody]',
        'erase every user, in B with no user set: reached []',
        `set every user's email, in B as the shared user: 42501: new row violates row-level security policy for table "users"`,
        'delete every membership, in B as the shared user: reached [memberships B shared]',
        "delete A's viewer's membership, in A as the shared user, A's owner: reached []",
        'delete every membership, with no tenant set, as the shared user: reached []',
        'delete every membership, in B with no user set: reached []',
      ]);
    } finally {
      await app.end();
    }
  });

  it("in B's context rff_app cannot insert a row of A or move a row to A in any table", async () => {
    expect(describeFindings(await crossTenantWriteFindings(asApp()))).toEqual([]);
  });

  it('rff_app reads no rows with no tenant set, on a new connection and on a pooled connection reused after a transaction in A', async () => {
    expect(describeFindings(await noTenantFindings(asApp()))).toEqual([]);
  });

  it('users: rff_app sees the current user and the members of the current tenant, and no other user', async () => {
    const { shared, aEditor, aViewer, bEditor, nobody } = fixture.users;
    const { tenantA: A, tenantB: B } = fixture;
    const cases: { tenant?: string; user?: string; sees: string[] }[] = [
      { tenant: B, user: shared.id, sees: [shared.id, bEditor.id] },
      { tenant: A, sees: [shared.id, aEditor.id, aViewer.id] },
      { tenant: B, user: aEditor.id, sees: [shared.id, bEditor.id, aEditor.id] },
      { tenant: randomUUID(), user: nobody.id, sees: [nobody.id] },
      { user: aEditor.id, sees: [aEditor.id] },
      { sees: [] },
    ];
    const app = await connectClient(database.appUrl, 'rff-test-isolation');
    try {
      const seen = await inSequence(cases, async ({ tenant, user }) => {
        await app.query('BEGIN');
        const settings = [
          ['app.tenant_id', tenant],
          ['app.user_id', user],
        ].filter((setting): setting is [string, string] => setting[1] !== undefined);
        await inSequence(settings, (setting) =>
          app.query('SELECT set_config($1, $2, true)', setting),
        );
        const { rows } = await app.query<{ id: string }>('SELECT id FROM public.users');
        await app.query('ROLLBACK');
        return rows.map((row) => row.id).toSorted();
      });
      expect(seen).toEqual(cases.map((c) => c.sees.toSorted()));
    } finally {
      await app.end();
    }
  });

  it('rff_app is no superuser, lacks BYPASSRLS, owns nothing, can create nothing, holds no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN, and holds only INSERT and SELECT on audit_log', async () => {
    expect(describeFindings(await privilegeFindings(asApp()))).toEqual([]);
    const { rows } = await admin.query<{ privilege: string }>(
      `SELECT privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                          'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p (privilege)
       WHERE pg_catalog.has_table_privilege('rff_app', 'public.audit_log', privilege)
          OR (privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              AND pg_catalog.has_any_column_privilege('rff_app', 'public.audit_log', privilege))
       ORDER BY 1`,
    );
    expect(rows.map((row) => row.privilege)).toEqual(['INSERT', 'SELECT']);
  });

  it('every SECURITY DEFINER function is on the allow-list, owned by rff_owner with search_path pg_catalog, pg_temp, returns one value, and is executable by rff_app and not by PUBLIC', async () => {
    const functions = await definerFunctions(admin, 'rff_app');
    expect(functions.map((fn) => fn.signature)).toEqual([
      ROLE_LOOKUP,
      MEMBERSHIPS_LOOKUP,
      KEY_LOOKUP,
      USER_LOOKUP,
    ]);
    expect(describeFindings(definerFindings(functions, DEFINER_ALLOW_LIST))).toEqual([]);
  });

  it("each look-up function returns the caller's row or NULL, the same under all 25 combinations of app.tenant_id and app.user_id", async () => {
    const cases = lookupCases(fixture);
    const settings = settingValues(fixture);
    const { findings, calls } = await lookupFindings(
      database.appUrl,
      cases,
      settings.tenant,
      settings.user,
    );
    expect(describeFindings(findings)).toEqual([]);
    expect(cases).toHaveLength(38);
    expect(calls).toBe(38 * 25);
    // Every function on the allow-list has cases, and each returns a row in some.
    for (const signature of Object.keys(DEFINER_ALLOW_LIST)) {
      const own = cases.filter((lookup) => lookup.signature === signature);
      expect(own.some((lookup) => lookup.expected !== null)).toBe(true);
      expect(own.some((lookup) => lookup.expected === null)).toBe(true);
    }
  });

  it('control: the same detectors on the superuser connection report every table', async () => {
    const subject = asSuperuser();
    for (const findings of [
      await selectFindings(subject),
      await writeFindings(subject),
      await crossTenantWriteFindings(subject),
      await noTenantFindings(subject),
    ]) {
      expect(relationsWithFindings(findings)).toEqual(TENANT_TABLES);
    }
    const privileges = describeFindings(await privilegeFindings(subject));
    expect(privileges).toContain('(role): is a superuser');
    expect(privileges).toContain('(role): has BYPASSRLS');
    expect(privileges).toContain(
      '(role): can create temporary tables, views and functions in the database',
    );
    expect(privileges).toContain('public.audit_log: holds TRUNCATE');
  });

  it('control: the same detectors on a table without row-level security in a scratch database report it', async () => {
    const scratch = await createScratchDatabase('isoplain');
    const role = await createScratchRole('isoplain');
    const plain = await connectClient(scratch.adminUrl, 'rff-test-isolation');
    const A = randomUUID();
    const B = randomUUID();
    const canary = `canary${randomBytes(6).toString('hex')}`;
    try {
      // notes has no row-level security; unseeded has no rows; peek is unlisted.
      await plain.query(`
        CREATE TABLE public.notes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          body text NOT NULL,
          title text
        );
        CREATE TABLE public.unseeded (tenant_id uuid NOT NULL, label text);
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.notes, public.unseeded
          TO ${ident(role.name)};
        CREATE FUNCTION public.peek() RETURNS bigint LANGUAGE sql SECURITY DEFINER
          RETURN (SELECT count(*) FROM public.notes);
      `);
      const reseed = async (): Promise<void> => {
        await plain.query(`
          TRUNCATE public.notes, public.unseeded;
          INSERT INTO public.notes (tenant_id, body) VALUES
            (${literal(A)}, ${literal(canary)}), (${literal(A)}, ${literal(canary)}),
            (${literal(B)}, 'a note of B');
        `);
      };
      await reseed();
      const universe = await reachableRelations(plain, role.name);
      expect(universe.relations.map((relation) => relation.name)).toEqual([
        'public.notes',
        'public.unseeded',
      ]);
      const subject: Subject = {
        admin: plain,
        role: role.name,
        url: scratch.urlFor(role),
        relations: universe.relations,
        rule: (relation) => tenancyRule(relation, {}),
        contexts: { A: { tenantId: A, userId: null }, B: { tenantId: B, userId: null } },
        reseed,
      };
      const notes = ['public.notes'];
      expect(relationsWithFindings(rowSecurityFindings(universe.relations))).toEqual([
        'public.notes',
        'public.unseeded',
      ]);
      expect(relationsWithFindings(await seedFindings(subject))).toEqual(['public.unseeded']);
      expect(
        describeFindings(await canaryFindings(subject, new Map([['public.notes.body', canary]]))),
      ).toEqual([
        'public.notes: column title has no canary of A: add one',
        'public.unseeded: column label has no canary of A: add one',
      ]);
      expect(relationsWithFindings(await selectFindings(subject))).toEqual(notes);
      expect(relationsWithFindings(await writeFindings(subject))).toEqual(notes);
      expect(relationsWithFindings(await crossTenantWriteFindings(subject))).toEqual([
        'public.notes',
        'public.unseeded',
      ]);
      expect(relationsWithFindings(await noTenantFindings(subject))).toEqual(notes);
      // A new database grants TEMPORARY to PUBLIC; migration 0002 revokes it.
      expect(describeFindings(await privilegeFindings(subject))).toEqual([
        '(role): can create temporary tables, views and functions in the database',
        'public.notes: holds TRUNCATE',
        'public.unseeded: holds TRUNCATE',
      ]);
      expect(
        describeFindings(
          definerFindings(await definerFunctions(plain, role.name), DEFINER_ALLOW_LIST),
        ),
      ).toEqual([
        `${USER_LOOKUP}: is on the allow-list but does not exist`,
        `${ROLE_LOOKUP}: is on the allow-list but does not exist`,
        `${KEY_LOOKUP}: is on the allow-list but does not exist`,
        `${MEMBERSHIPS_LOOKUP}: is on the allow-list but does not exist`,
        'public.peek(): is SECURITY DEFINER and not on the allow-list: add it with its cases',
      ]);
    } finally {
      await plain.end();
    }
  });

  it('control: tables whose policies have one defect each, a foreign key that reaches across tenants, and a pool that does not reuse its connection, are each reported by the check that covers it', async () => {
    const scratch = await createScratchDatabase('isodefects');
    const role = await createScratchRole('isodefects');
    const plain = await connectClient(scratch.adminUrl, 'rff-test-isolation');
    const A = randomUUID();
    const B = randomUUID();
    const canary = `canary${randomBytes(6).toString('hex')}`;
    const noteOfB = 'a note of B';
    const current = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
    const isolated = `USING (tenant_id = ${current}) WITH CHECK (tenant_id = ${current})`;
    // One table per defect, named after it, each with two rows of A and two of B;
    // sound has none. The grants follow rff_app's: UPDATE on body only, so no UPDATE
    // can move a row to another tenant. A's rows of cascade_child point at B's rows of
    // cascade_parent, and deleting those deletes them too, because a foreign key's
    // ON DELETE CASCADE skips row-level security.
    const tables: Record<string, readonly string[]> = {
      blank_leak: [
        `USING (tenant_id = ${current} OR current_setting('app.tenant_id', true) = '')
         WITH CHECK (tenant_id = ${current})`,
      ],
      canary_in_b: [isolated],
      cascade_parent: [isolated],
      cascade_child: [isolated],
      inverted: [`USING (tenant_id <> ${current})`],
      sound: [isolated],
      unforced: [isolated],
      unset_leak: [
        `USING (tenant_id = ${current} OR current_setting('app.tenant_id', true) IS NULL)
         WITH CHECK (tenant_id = ${current})`,
      ],
      update_leak: [isolated, 'FOR UPDATE USING (true)'],
    };
    const names = Object.keys(tables);
    const parentsOfB = [randomUUID(), randomUUID()];
    try {
      await inSequence(Object.entries(tables), ([name, policies]) => {
        const parent =
          name === 'cascade_child'
            ? ', parent_id uuid NOT NULL REFERENCES public.cascade_parent (id) ON DELETE CASCADE'
            : '';
        return plain.query(
          [
            `CREATE TABLE public.${name} (
               id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
               tenant_id uuid NOT NULL,
               body text NOT NULL${parent}
             )`,
            `ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`,
            ...(name === 'unforced' ? [] : [`ALTER TABLE public.${name} FORCE ROW LEVEL SECURITY`]),
            ...policies.map(
              (policy, index) => `CREATE POLICY p${index} ON public.${name} ${policy}`,
            ),
            `GRANT SELECT, INSERT, DELETE, UPDATE (body) ON public.${name} TO ${ident(role.name)}`,
          ].join(';\n'),
        );
      });
      const reseed = async (): Promise<void> => {
        await plain.query(`TRUNCATE ${names.map((name) => `public.${name}`).join(', ')}`);
        await inSequence(names, (name) => {
          const ids = Array.from({ length: 4 }, () => randomUUID());
          if (name === 'cascade_parent') ids.splice(2, 2, ...parentsOfB);
          const columns = [
            ids,
            [A, A, B, B],
            [canary, canary, name === 'canary_in_b' ? canary : noteOfB, noteOfB],
          ];
          return name === 'cascade_child'
            ? plain.query(
                `INSERT INTO public.cascade_child (id, tenant_id, body, parent_id)
                 SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::uuid[])`,
                [...columns, [...parentsOfB, ...parentsOfB]],
              )
            : plain.query(
                `INSERT INTO public.${name} (id, tenant_id, body)
                 SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[])`,
                columns,
              );
        });
      };
      await reseed();
      const universe = await reachableRelations(plain, role.name);
      expect(universe.relations.map((relation) => relation.name)).toEqual(
        names.map((name) => `public.${name}`).toSorted(),
      );
      const subject: Subject = {
        admin: plain,
        role: role.name,
        url: scratch.urlFor(role),
        relations: universe.relations,
        rule: (relation) => tenancyRule(relation, {}),
        contexts: { A: { tenantId: A, userId: null }, B: { tenantId: B, userId: null } },
        reseed,
      };
      const canaries = new Map(names.map((name) => [`public.${name}.body`, canary]));

      expect(describeFindings(rowSecurityFindings(universe.relations))).toEqual([
        'public.unforced: row-level security is not forced',
      ]);
      expect(describeFindings(await seedFindings(subject))).toEqual([]);
      expect(describeFindings(await canaryFindings(subject, canaries))).toEqual([
        "public.canary_in_b: column body: a row B sees holds A's canary",
      ]);
      // inverted shows B as many rows as B has, all of them A's.
      expect(describeFindings(await selectFindings(subject))).toEqual([
        "public.inverted: B's context reads rows other than B's",
      ]);
      expect(describeFindings(await writeFindings(subject))).toEqual([
        "public.cascade_parent: an unfiltered DELETE in B's context changed rows outside B in public.cascade_child (2 rows before, 0 after)",
        "public.inverted: an unfiltered UPDATE in B's context changed rows outside B in public.inverted (2 rows before, 2 after)",
        "public.inverted: an unfiltered DELETE in B's context changed rows outside B in public.inverted (2 rows before, 0 after)",
        "public.update_leak: an unfiltered UPDATE in B's context changed rows outside B in public.update_leak (2 rows before, 2 after)",
        "public.update_leak: UPDATE in B's context reached 4 rows; B has 2",
      ]);
      expect(describeFindings(await crossTenantWriteFindings(subject))).toEqual([
        "public.inverted: an INSERT of a row of A in B's context was not refused by the policy: it succeeded on 1 rows",
      ]);
      expect(describeFindings(await noTenantFindings(subject))).toEqual([
        'public.unset_leak: a new connection with no tenant set reads 4 rows',
        "public.blank_leak: the connection reused after A's transaction reads 4 rows",
      ]);

      // A pool that opens a new connection for each use never shows what a reused one
      // reads, so the reused-connection check must notice the new backend.
      const replacing: Subject = {
        ...subject,
        relations: universe.relations.filter((relation) => relation.name === 'public.sound'),
        pool: () => {
          const pool = new pg.Pool({ connectionString: subject.url, max: 1, maxUses: 1 });
          pool.on('error', () => {});
          return pool;
        },
      };
      expect(describeFindings(await noTenantFindings(replacing))).toEqual([
        'public.sound: the pool did not reuse the connection',
      ]);
    } finally {
      await plain.end();
    }
  });

  it("control: a declared reach wider than its policy's, such as a user's deletion reaching the user's memberships in every tenant, is reported by the reach count; a DELETE policy that reaches the current user's rows in every tenant is reported by the outside-B checksum, which a declared reach does not change; and one that reaches as many rows of B as declared, but another user's, is reported by the checksum of the rows outside the declared reach", async () => {
    // The migrated schema, with memberships' DELETE declared to reach the shared
    // user's memberships in every tenant. The policy reaches only the one in B.
    const memberships = relations.filter((relation) => relation.name === 'public.memberships');
    const declared = tenancyRule(memberships[0]!);
    const everyTenant: TenancyRule = {
      ...declared!,
      reach: { DELETE: (scope) => `t.user_id = ${uuidLiteral(scope.userId)}` },
    };
    expect(
      describeFindings(
        await writeFindings({ ...asApp(), relations: memberships, rule: () => everyTenant }),
      ),
    ).toEqual(["public.memberships: DELETE in B's context reached 1 rows; its reach in B has 2"]);

    // Three tables in a scratch database whose DELETE policies reach one user's rows:
    // leave_here the current user's in the current tenant only, as memberships does;
    // leave_everywhere the current user's in every tenant; leave_other another user's
    // in the current tenant. leave_here and leave_everywhere declare their policy's
    // reach exactly. leave_other declares leave_here's reach, as many rows as its
    // policy reaches in B, and other ones.
    const scratch = await createScratchDatabase('isoreach');
    const role = await createScratchRole('isoreach');
    const plain = await connectClient(scratch.adminUrl, 'rff-test-isolation');
    const A = randomUUID();
    const B = randomUUID();
    const user = randomUUID();
    const other = randomUUID();
    const canary = `canary${randomBytes(6).toString('hex')}`;
    const tenant = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
    const me = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
    const tables = {
      leave_everywhere: `FOR DELETE USING (user_id = ${me})`,
      leave_here: `AS RESTRICTIVE FOR DELETE USING (user_id = ${me})`,
      leave_other: `AS RESTRICTIVE FOR DELETE USING (user_id <> ${me})`,
    };
    try {
      await inSequence(Object.entries(tables), ([name, policy]) =>
        plain.query(
          [
            `CREATE TABLE public.${name} (
               id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
               tenant_id uuid NOT NULL,
               user_id uuid NOT NULL,
               body text NOT NULL
             )`,
            `ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`,
            `ALTER TABLE public.${name} FORCE ROW LEVEL SECURITY`,
            `CREATE POLICY isolated ON public.${name}
               USING (tenant_id = ${tenant}) WITH CHECK (tenant_id = ${tenant})`,
            `CREATE POLICY leave ON public.${name} ${policy}`,
            `GRANT SELECT, DELETE, UPDATE (body) ON public.${name} TO ${ident(role.name)}`,
          ].join(';\n'),
        ),
      );
      const reseed = async (): Promise<void> => {
        await inSequence(Object.keys(tables), async (name) => {
          await plain.query(`TRUNCATE public.${name}`);
          await plain.query(
            `INSERT INTO public.${name} (tenant_id, user_id, body)
             SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[])`,
            [
              [A, A, B, B],
              [user, other, user, other],
              [canary, canary, 'a row of B', 'a row of B'],
            ],
          );
        });
      };
      await reseed();
      const universe = await reachableRelations(plain, role.name);
      const reach: Record<string, (scope: Scope) => string> = {
        'public.leave_everywhere': (scope) =>
          `(t.tenant_id = ${uuidLiteral(scope.tenantId)} OR t.user_id = ${uuidLiteral(scope.userId)})`,
        'public.leave_here': ownRowsIn,
        'public.leave_other': ownRowsIn,
      };
      const subject: Subject = {
        admin: plain,
        role: role.name,
        url: scratch.urlFor(role),
        relations: universe.relations,
        rule: (relation) => {
          const rule = tenancyRule(relation, {});
          const own = reach[relation.name];
          return rule === undefined || own === undefined
            ? rule
            : { ...rule, reach: { DELETE: own } };
        },
        contexts: { A: { tenantId: A, userId: user }, B: { tenantId: B, userId: user } },
        reseed,
      };
      expect(universe.relations.map((relation) => relation.name)).toEqual(Object.keys(reach));
      // leave_other's DELETE reaches one row of B, as many as declared, and the
      // checksum of the rows outside the declared reach reports that it is another.
      expect(describeFindings(await writeFindings(subject))).toEqual([
        "public.leave_everywhere: an unfiltered DELETE in B's context changed rows outside B in public.leave_everywhere (2 rows before, 1 after)",
        "public.leave_other: an unfiltered DELETE in B's context changed rows outside its reach (3 rows before, 2 after)",
      ]);
    } finally {
      await plain.end();
    }
  });

  it('control: SECURITY DEFINER functions that each break one rule of the allow-list are reported', async () => {
    const scratch = await createScratchDatabase('isodefiners');
    const role = await createScratchRole('isodefiners');
    const owner = await createScratchGroup('isodefinerowner');
    const plain = await connectClient(scratch.adminUrl, 'rff-test-isolation');
    const fixed = 'SET search_path = pg_catalog, pg_temp';
    try {
      // Every function but wrong_owner is owned by the scratch group, and every one but
      // public_executes and not_granted can be run by the role and not by PUBLIC.
      await plain.query(`
        CREATE FUNCTION public.sound() RETURNS int LANGUAGE sql SECURITY DEFINER ${fixed} RETURN 1;
        CREATE FUNCTION public.wrong_owner() RETURNS int LANGUAGE sql SECURITY DEFINER ${fixed}
          RETURN 1;
        CREATE FUNCTION public.no_search_path() RETURNS int LANGUAGE sql SECURITY DEFINER RETURN 1;
        CREATE FUNCTION public.returns_rows() RETURNS SETOF int LANGUAGE sql SECURITY DEFINER
          ${fixed} BEGIN ATOMIC SELECT 1; END;
        CREATE FUNCTION public.public_executes() RETURNS int LANGUAGE sql SECURITY DEFINER
          ${fixed} RETURN 1;
        CREATE FUNCTION public.not_granted() RETURNS int LANGUAGE sql SECURITY DEFINER ${fixed}
          RETURN 1;
        CREATE FUNCTION public.unlisted() RETURNS int LANGUAGE sql SECURITY DEFINER ${fixed}
          RETURN 1;
        ${['sound', 'no_search_path', 'returns_rows', 'public_executes', 'not_granted', 'unlisted']
          .map((name) => `ALTER FUNCTION public.${name}() OWNER TO ${ident(owner)};`)
          .join('\n')}
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ident(role.name)};
        GRANT EXECUTE ON FUNCTION public.public_executes() TO PUBLIC;
        REVOKE EXECUTE ON FUNCTION public.not_granted() FROM ${ident(role.name)};
      `);
      const listed: AllowedDefiner = { owner, config: ['search_path=pg_catalog, pg_temp'] };
      const allowList = Object.fromEntries(
        [
          'sound',
          'wrong_owner',
          'no_search_path',
          'returns_rows',
          'public_executes',
          'not_granted',
          'missing',
        ].map((name) => [`public.${name}()`, listed]),
      );
      expect(
        describeFindings(definerFindings(await definerFunctions(plain, role.name), allowList)),
      ).toEqual([
        'public.missing(): is on the allow-list but does not exist',
        'public.no_search_path(): runs with [], not ["search_path=pg_catalog, pg_temp"]',
        'public.not_granted(): the role under test cannot execute it',
        'public.public_executes(): PUBLIC can execute it',
        'public.returns_rows(): returns a set of rows',
        'public.unlisted(): is SECURITY DEFINER and not on the allow-list: add it with its cases',
        `public.wrong_owner(): is owned by ${userOf(scratch.adminUrl)}, not ${owner}`,
      ]);
    } finally {
      await plain.end();
    }
  });

  it('control: look-up functions with one defect each, and an unlisted SECURITY DEFINER function, are reported', async () => {
    const broken = await createMigratedDatabase('isolookups');
    const brokenAdmin = await connectClient(broken.adminUrl, 'rff-test-isolation');
    try {
      await fixture.seed(brokenAdmin);
      await brokenAdmin.query(
        await readFile(new URL('./fixtures/isolation/broken-lookups.sql', import.meta.url), 'utf8'),
      );
      const settings = settingValues(fixture);
      const { findings } = await lookupFindings(
        broken.appUrl,
        lookupCases(fixture),
        settings.tenant,
        settings.user,
      );
      expect(relationsWithFindings(findings)).toEqual([
        ROLE_LOOKUP,
        MEMBERSHIPS_LOOKUP,
        KEY_LOOKUP,
        USER_LOOKUP,
      ]);
      const details = describeFindings(findings).join('\n');
      expect(details).toContain("user for the shared user's subject at another issuer");
      expect(details).toContain('role of the shared user in B with app.tenant_id A');
      expect(details).toContain("tenant for A's revoked key");
      expect(details).toContain(
        "memberships of A's editor with app.tenant_id A and app.user_id the shared user",
      );
      expect(
        describeFindings(
          definerFindings(await definerFunctions(brokenAdmin, 'rff_app'), DEFINER_ALLOW_LIST),
        ),
      ).toEqual([
        'public.user_emails(): is SECURITY DEFINER and not on the allow-list: add it with its cases',
      ]);
    } finally {
      await brokenAdmin.end();
    }
  });
});
