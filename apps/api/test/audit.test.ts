import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/database/pool.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import { reachableRelations } from './isolation/catalogue.js';
import { inSequence, visibleRowSums } from './isolation/detectors.js';
import { type FixtureUser, tenancyRule } from './isolation/fixture.js';
import { flagOnlyInA, ROUTE_CASES } from './isolation/routes.js';
import { type Call, type Environment, startEnvironment } from './support/api.js';

// The audit log: one row per change, written in the change's transaction, by the
// signed-in user, and out of reach of UPDATE and DELETE for the API's role.

let env: Environment;

beforeAll(async () => {
  env = await startEnvironment('audit');
});

afterAll(async () => {
  await env?.close();
});

interface AuditRow {
  id: string;
  actor_user_id: string;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  version: string | null;
}

async function auditOfA(): Promise<AuditRow[]> {
  const { rows } = await env.admin.query<AuditRow>(
    `SELECT a.id::text AS id, a.actor_user_id, a.action, a.target, a.before, a.after,
            a.version::text AS version
     FROM public.audit_log a WHERE a.tenant_id = $1 ORDER BY a.id`,
    [env.world.fixture.tenantA],
  );
  return rows;
}

/** A row the change writes: the table and the condition that finds it after the change. */
interface WrittenRow {
  readonly table: 'tenants' | 'flags' | 'memberships' | 'sdk_keys' | 'audit_log';
  readonly where: string;
  readonly params: readonly unknown[];
}

/**
 * The xmin of the row, read on the superuser connection: the id of the transaction
 * that wrote it. Two rows with one xmin were written by one transaction.
 */
async function xminOf(row: WrittenRow): Promise<string> {
  const { rows } = await env.admin.query<{ xmin: string }>(
    `SELECT xmin::text AS xmin FROM public.${row.table} WHERE ${row.where}`,
    [...row.params],
  );
  if (rows.length !== 1) throw new Error(`${rows.length} rows in ${row.table} for ${row.where}`);
  return rows[0]!.xmin;
}

async function versionOfA(): Promise<string> {
  const { rows } = await env.admin.query<{ version: string }>(
    'SELECT version::text FROM public.tenants WHERE id = $1',
    [env.world.fixture.tenantA],
  );
  return rows[0]?.version ?? 'none';
}

interface Mutation {
  readonly route: string;
  readonly user: () => FixtureUser;
  readonly call: () => Call;
  readonly action: string;
  readonly target: (reply: unknown) => string;
  readonly before: unknown;
  readonly after: (reply: unknown) => unknown;
  /** Whether the change is a flag write, which raises the tenant's version. */
  readonly versioned: boolean;
  /** The rows the change itself writes, which its audit row must share a transaction with. */
  readonly written: (reply: unknown) => WrittenRow[];
}

function mutations(): Mutation[] {
  const { fixture, people } = env.world;
  const flags = `/tenants/${fixture.tenantA}/flags`;
  const canaryKey = flagOnlyInA(env.world);
  const checkout = { enabled: true, rules: [], rolloutBasisPoints: 2500 };
  const tenantRow: WrittenRow = { table: 'tenants', where: 'id = $1', params: [fixture.tenantA] };
  const flagRow = (key: string): WrittenRow => ({
    table: 'flags',
    where: 'tenant_id = $1 AND key = $2',
    params: [fixture.tenantA, key],
  });
  return [
    {
      route: 'POST /tenants/:tenantId/flags',
      user: () => people.editorOfA,
      call: () => ({
        method: 'POST',
        path: flags,
        body: { key: 'with-audit-row', enabled: true, rules: [], rolloutBasisPoints: 10 },
      }),
      action: 'flag.create',
      target: () => 'with-audit-row',
      before: null,
      after: (reply) => (reply as { flag: unknown }).flag,
      versioned: true,
      written: () => [tenantRow, flagRow('with-audit-row')],
    },
    {
      route: 'PUT /tenants/:tenantId/flags/:flagKey',
      user: () => people.editorOfA,
      call: () => ({
        method: 'PUT',
        path: `${flags}/checkout`,
        body: { ...checkout, rolloutBasisPoints: 3000 },
      }),
      action: 'flag.update',
      target: () => 'checkout',
      before: { key: 'checkout', salt: expect.stringMatching(/^[0-9a-f]{16}$/), ...checkout },
      after: (reply) => (reply as { flag: unknown }).flag,
      versioned: true,
      written: () => [tenantRow, flagRow('checkout')],
    },
    {
      route: 'DELETE /tenants/:tenantId/flags/:flagKey',
      user: () => people.editorOfA,
      call: () => ({ method: 'DELETE', path: `${flags}/${canaryKey}` }),
      action: 'flag.delete',
      target: () => canaryKey,
      before: expect.objectContaining({ key: canaryKey, rolloutBasisPoints: 5000 }),
      after: () => null,
      versioned: true,
      // The deleted flag row is gone; the version bump is in the same transaction.
      written: () => [tenantRow],
    },
    {
      route: 'PUT /tenants/:tenantId/members/:userId',
      user: () => people.shared,
      call: () => ({
        method: 'PUT',
        path: `/tenants/${fixture.tenantA}/members/${people.viewerOfA.id}`,
        body: { role: 'editor' },
      }),
      action: 'member.role',
      target: () => people.viewerOfA.id,
      before: { role: 'viewer' },
      after: () => ({ role: 'editor' }),
      versioned: false,
      written: () => [
        {
          table: 'memberships',
          where: 'tenant_id = $1 AND user_id = $2',
          params: [fixture.tenantA, people.viewerOfA.id],
        },
      ],
    },
    {
      route: 'POST /tenants/:tenantId/sdk-keys',
      user: () => people.shared,
      call: () => ({ method: 'POST', path: `/tenants/${fixture.tenantA}/sdk-keys` }),
      action: 'sdk_key.create',
      target: (reply) => (reply as { id: string }).id,
      before: null,
      after: (reply) => ({ id: (reply as { id: string }).id }),
      versioned: false,
      written: (reply) => [
        { table: 'sdk_keys', where: 'id = $1', params: [(reply as { id: string }).id] },
      ],
    },
  ];
}

describe('audit log', () => {
  it('the mutations below are every route that changes data: each case-table route other than the GETs and POST /evaluate', () => {
    const changing = ROUTE_CASES.filter(
      (routeCase) =>
        !routeCase.route.startsWith('GET ') &&
        routeCase.route !== 'POST /tenants/:tenantId/evaluate',
    ).map((routeCase) => routeCase.route);
    expect(mutations().map((mutation) => mutation.route)).toEqual(changing);
  });

  it("each mutating route's success adds exactly one audit row, written by the change's own transaction, whose actor is the token's user and whose version is the new tenant version for flag writes and empty for member and SDK key changes", async () => {
    for (const mutation of mutations()) {
      // eslint-disable-next-line no-await-in-loop -- each mutation starts from the seeded rows
      await env.world.seed(env.admin);
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const before = { rows: await auditOfA(), version: await versionOfA() };
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const reply = await env.send(mutation.user(), mutation.call());
      expect(reply.status, mutation.route).toBeLessThan(300);
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const after = { rows: await auditOfA(), version: await versionOfA() };
      const added = after.rows.slice(before.rows.length);
      expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
      expect(added, mutation.route).toEqual([
        {
          id: expect.any(String),
          actor_user_id: mutation.user().id,
          action: mutation.action,
          target: mutation.target(reply.body),
          before: mutation.before,
          after: mutation.after(reply.body),
          version: mutation.versioned ? after.version : null,
        },
      ]);
      // A flag write raises the version by one and returns it; the others leave it.
      expect({
        raisedBy: Number(after.version) - Number(before.version),
        returned: (reply.body as { version?: number }).version,
      }).toEqual(
        mutation.versioned
          ? { raisedBy: 1, returned: Number(after.version) }
          : { raisedBy: 0, returned: undefined },
      );
      // The audit row and the rows the change wrote carry one xmin: one transaction
      // wrote them, so they commit together. An audit row written and committed on
      // another connection, or after a COMMIT on this one, has another xmin.
      const written = mutation.written(reply.body);
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const auditXmin = await xminOf({
        table: 'audit_log',
        where: 'id = $1',
        params: [added[0]?.id],
      });
      // eslint-disable-next-line no-await-in-loop -- one request at a time
      const xmins = await inSequence(written, xminOf);
      expect(xmins, mutation.route).toEqual(written.map(() => auditXmin));
      expect(written.length, mutation.route).toBeGreaterThan(0);
    }
    // The SDK key's row names it by id only: neither the key nor its hash is stored there.
    await env.world.seed(env.admin);
    const created = await env.send(env.world.people.shared, mutations()[4]!.call());
    const { key } = created.body as { key: string };
    expect(JSON.stringify(await auditOfA())).not.toContain(key);
  });

  it('a failure after the change and its audit row are written leaves neither, for every mutating route, and the same requests succeed once the failure is gone', async () => {
    const { relations } = await reachableRelations(env.admin, 'rff_app');
    const rowsOfA = () =>
      visibleRowSums(
        env.admin,
        relations,
        (relation) => tenancyRule(relation),
        env.world.fixture.contexts.A,
      );
    // Fires after each audit row that rff_app inserts, so the change and the row are
    // both written when the transaction fails.
    await env.admin.query(`
      CREATE FUNCTION public.fail_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_user = 'rff_app' THEN
          RAISE EXCEPTION 'forced failure after the audit row';
        END IF;
        RETURN NULL;
      END
      $$;
      CREATE TRIGGER fail_after_audit AFTER INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.fail_after_audit();
    `);
    try {
      await inSequence(mutations(), async (mutation) => {
        await env.world.seed(env.admin);
        const before = await rowsOfA();
        const reply = await env.send(mutation.user(), mutation.call());
        expect(reply.status, mutation.route).toBe(500);
        expect([...(await rowsOfA())], mutation.route).toEqual([...before]);
      });
    } finally {
      await env.admin.query(`
        DROP TRIGGER fail_after_audit ON public.audit_log;
        DROP FUNCTION public.fail_after_audit();
      `);
    }
    const statuses = await inSequence(mutations(), async (mutation) => {
      await env.world.seed(env.admin);
      return (await env.send(mutation.user(), mutation.call())).status;
    });
    expect(statuses).toEqual([201, 200, 200, 200, 201]);
  });

  it("rff_app's UPDATE and DELETE on audit_log are refused, in its own tenant's context too, and the rows stay", async () => {
    await env.world.seed(env.admin);
    const before = await auditOfA();
    const pool = createPool(
      { url: env.database.appUrl, poolMax: 1, connectDeadlineMs: 0 },
      { log: () => {}, warn: () => {}, error: () => {} },
    );
    try {
      const db = new TenantDatabase(pool);
      const attempts = [
        'UPDATE public.audit_log SET action = action',
        "UPDATE public.audit_log SET actor_user_id = gen_random_uuid() WHERE target = 'checkout'",
        'DELETE FROM public.audit_log',
        "DELETE FROM public.audit_log WHERE target = 'checkout'",
        'TRUNCATE public.audit_log',
      ];
      const outcomes = await inSequence(attempts, (sql) =>
        db
          .withTenant(env.world.fixture.contexts.A, (client) => client.query(sql))
          .then(
            () => 'succeeded',
            (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
          ),
      );
      expect(outcomes).toEqual(attempts.map(() => '42501: permission denied for table audit_log'));
    } finally {
      await pool.end();
    }
    expect(await auditOfA()).toEqual(before);
  });

  it("GET /audit returns the tenant's rows newest first, 100 at a time, and ?before=<id> gives the next page", async () => {
    await env.world.seed(env.admin);
    const { fixture, people } = env.world;
    await env.admin.query(
      `INSERT INTO public.audit_log (tenant_id, actor_user_id, action, target, version)
       SELECT $1, $2, 'flag.update', 'checkout', 3 + n FROM generate_series(1, 150) AS n`,
      [fixture.tenantA, people.editorOfA.id],
    );
    const all = (await auditOfA()).map((row) => Number(row.id)).toReversed();
    const page = async (query: string) => {
      const reply = await env.send(people.viewerOfA, {
        method: 'GET',
        path: `/tenants/${fixture.tenantA}/audit${query}`,
      });
      return {
        status: reply.status,
        ids: ((reply.body as { entries?: { id: number }[] }).entries ?? []).map((e) => e.id),
      };
    };
    const first = await page('');
    expect(first).toEqual({ status: 200, ids: all.slice(0, 100) });
    const second = await page(`?before=${first.ids.at(-1)}`);
    expect(second).toEqual({ status: 200, ids: all.slice(100) });
    expect((await page('?before=abc')).status).toBe(400);
    expect((await page('?before=0')).status).toBe(400);
  });
});
