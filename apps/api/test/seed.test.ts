import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { DEMO_TENANTS, DEMO_USERS } from '../src/seed/demo-data.js';
import { dexSubject } from '../src/seed/dex-subject.js';
import { seedDemo } from '../src/seed/seed.js';
import { createMigratedDatabase, type MigratedDatabase } from './harness/context.js';
import { apiConfig, request, type RunningApi, startApi } from './support/api.js';
import { type LocalIdp, startIdp } from './support/idp.js';
import { openStream, snapshotsOf } from './support/sse.js';

// The compose stack's demo data (apps/api/src/seed): the users Dex signs in
// (dex/local-demo-config.yaml), found by the subject Dex gives them, and a seed that
// can run on every "docker compose up". Each test seeds a migrated database of its
// own, because the seed writes fixed tenant and user ids.

const DEX_CONFIG = new URL('../../../dex/local-demo-config.yaml', import.meta.url);
const COMPOSE = new URL('../../../compose.yaml', import.meta.url);
const ISSUER = 'http://127.0.0.1:5556/dex';

const TABLES = ['tenants', 'users', 'memberships', 'flags', 'sdk_keys', 'audit_log'] as const;

/** Every row of every tenant table, as JSON, in a fixed order. */
async function allRows(admin: pg.ClientBase): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown> = {};
  for (const table of TABLES) {
    // eslint-disable-next-line no-await-in-loop -- one client, one query at a time
    const { rows: result } = await admin.query<{ rows: unknown }>(
      `SELECT coalesce(json_agg(t ORDER BY t::text), '[]'::json) AS rows FROM public.${table} t`,
    );
    rows[table] = result[0]?.rows;
  }
  return rows;
}

/** The static users of the Dex configuration: each list item's email, name and userID. */
function staticUsers(yaml: string): { email: string; name: string; dexUserId: string }[] {
  const section = /^staticPasswords:\n((?:[ -].*\n|\n)*)/m.exec(yaml)?.[1] ?? '';
  return section
    .split(/^ {2}- /m)
    .slice(1)
    .map((item) => {
      const field = (name: string): string =>
        new RegExp(`^(?: {4})?${name}: (.+)$`, 'm').exec(item)?.[1]?.trim() ?? '';
      return { email: field('email'), name: field('name'), dexUserId: field('userID') };
    });
}

describe('demo seed', () => {
  it('dexSubject gives the subject of a real Dex token', () => {
    // The "sub" of an access token that Dex v2.46.0 issued for the static user with
    // this userID, signed in through the password database (connector "local").
    expect(dexSubject('7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1001')).toBe(
      'CiQ3ZDFjMmIwZS01ZjQzLTRlMWEtOWE1NS0wYzZkMWYwYTEwMDESBWxvY2Fs',
    );
    // Another connector gives another subject, and the result has no padding.
    expect(dexSubject('7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1001', 'github')).not.toBe(
      dexSubject('7d1c2b0e-5f43-4e1a-9a55-0c6d1f0a1001'),
    );
    expect(dexSubject('a')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("the seeded users are exactly Dex's static users, and all parts share one issuer", async () => {
    const yaml = await readFile(DEX_CONFIG, 'utf8');
    const fromDex = staticUsers(yaml);
    expect(fromDex).toHaveLength(DEMO_USERS.length);
    expect(fromDex.every((user) => user.dexUserId !== '')).toBe(true);
    expect(fromDex).toEqual(
      DEMO_USERS.map(({ email, name, dexUserId }) => ({ email, name, dexUserId })),
    );
    expect(/^issuer: (.+)$/m.exec(yaml)?.[1]).toBe(ISSUER);
    const compose = await readFile(COMPOSE, 'utf8');
    const issuers = [...compose.matchAll(/^\s+RFF_(?:AUTH|SEED|OIDC)_ISSUER: (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(issuers).toEqual([ISSUER, ISSUER, ISSUER]);
  });

  describe('on a migrated database', () => {
    let database: MigratedDatabase;
    let admin: pg.Client;

    beforeAll(async () => {
      database = await createMigratedDatabase('seed');
      admin = await connectClient(database.adminUrl, 'rff-test-seed');
    });

    afterAll(async () => {
      await admin?.end();
    });

    it('runs once and keeps erased users erased', async () => {
      const first = await seedDemo(admin, { issuer: ISSUER });
      expect(first).toEqual({
        usersCreated: 4,
        tenantsCreated: ['acme', 'globex'],
        tenantsKept: [],
      });
      const counts = await admin.query<{ table: string; count: number }>(
        `SELECT 'tenants' AS table, count(*)::int AS count FROM public.tenants
         UNION ALL SELECT 'users', count(*)::int FROM public.users
         UNION ALL SELECT 'memberships', count(*)::int FROM public.memberships
         UNION ALL SELECT 'flags', count(*)::int FROM public.flags
         UNION ALL SELECT 'sdk_keys', count(*)::int FROM public.sdk_keys
         UNION ALL SELECT 'audit_log', count(*)::int FROM public.audit_log`,
      );
      expect(Object.fromEntries(counts.rows.map((row) => [row.table, row.count]))).toEqual({
        tenants: 2,
        users: 4,
        memberships: 5,
        flags: 5,
        sdk_keys: 2,
        audit_log: 0,
      });
      const seeded = await allRows(admin);

      expect(await seedDemo(admin, { issuer: ISSUER })).toEqual({
        usersCreated: 0,
        tenantsCreated: [],
        tenantsKept: ['acme', 'globex'],
      });
      expect(await allRows(admin)).toEqual(seeded);

      // Alice erases herself as DELETE /me does; then acme is removed and seeded again.
      const alice = DEMO_USERS.find((user) => user.email === 'alice@example.test')!;
      const acme = DEMO_TENANTS.find((tenant) => tenant.slug === 'acme')!;
      await admin.query(
        `UPDATE public.users SET idp_issuer = NULL, idp_subject = NULL, email = NULL, name = NULL
         WHERE id = $1`,
        [alice.id],
      );
      await admin.query('DELETE FROM public.memberships WHERE user_id = $1', [alice.id]);
      await admin.query('DELETE FROM public.tenants WHERE id = $1', [acme.id]);

      expect(await seedDemo(admin, { issuer: ISSUER })).toEqual({
        usersCreated: 0,
        tenantsCreated: ['acme'],
        tenantsKept: ['globex'],
      });
      const { rows: erased } = await admin.query(
        'SELECT idp_issuer, idp_subject, email, name FROM public.users WHERE id = $1',
        [alice.id],
      );
      expect(erased).toEqual([{ idp_issuer: null, idp_subject: null, email: null, name: null }]);
      const { rows: members } = await admin.query<{ email: string; role: string }>(
        `SELECT u.email, m.role::text AS role FROM public.memberships m
         JOIN public.users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY u.email`,
        [acme.id],
      );
      expect(members).toEqual([
        { email: 'bob@example.test', role: 'viewer' },
        { email: 'carol@example.test', role: 'editor' },
      ]);
      expect((await admin.query('SELECT 1 FROM public.users')).rowCount).toBe(4);
    });
  });

  describe('through the API', () => {
    let database: MigratedDatabase;
    let idp: LocalIdp;
    let api: RunningApi;

    beforeAll(async () => {
      database = await createMigratedDatabase('seedapi');
      const admin = await connectClient(database.adminUrl, 'rff-test-seed');
      try {
        await seedDemo(admin, { issuer: ISSUER });
      } finally {
        await admin.end();
      }
      // The local identity provider signs as Dex's issuer, for the subjects Dex gives.
      idp = await startIdp(ISSUER);
      api = await startApi(apiConfig(database.appUrl, idp, 'seed-test'));
    });

    afterAll(async () => {
      await api?.close();
      await idp?.close();
    });

    it("seeded users sign in with their roles, and seeded keys open their tenant's stream", async () => {
      const bob = DEMO_USERS.find((user) => user.email === 'bob@example.test')!;
      const token = await idp.token(dexSubject(bob.dexUserId));
      const me = await request(api.base, { method: 'GET', path: '/me' }, `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({
        id: bob.id,
        email: bob.email,
        name: bob.name,
        memberships: [
          { tenantId: DEMO_TENANTS[0]!.id, slug: 'acme', name: 'Acme', role: 'viewer' },
          { tenantId: DEMO_TENANTS[1]!.id, slug: 'globex', name: 'Globex', role: 'editor' },
        ],
      });

      for (const tenant of DEMO_TENANTS) {
        // eslint-disable-next-line no-await-in-loop -- one stream at a time
        const stream = await openStream(api.base, { authorization: `Bearer ${tenant.sdkKey}` });
        try {
          expect(stream.status).toBe(200);
          // eslint-disable-next-line no-await-in-loop -- waits for this stream's snapshot
          await stream.until(() => snapshotsOf(stream).length > 0, `the ${tenant.slug} snapshot`);
          // The snapshot lists flags by key.
          expect(snapshotsOf(stream)[0]).toEqual({
            tenantId: tenant.id,
            version: 1,
            flags: tenant.flags.toSorted((a, b) => (a.key < b.key ? -1 : 1)),
          });
        } finally {
          stream.close();
        }
      }
    });
  });
});
