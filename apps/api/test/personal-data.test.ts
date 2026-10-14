import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { connectClient } from '../src/database/connect.js';
import { createPool } from '../src/database/pool.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import { MeController } from '../src/me/me.controller.js';
import { USER_EXPORT_EXCLUDED, USER_EXPORT_FIELDS } from '../src/me/personal-data.js';
import { createMigratedDatabase, harness } from './harness/context.js';
import { escapeGlob, type Redis } from './harness/redis.js';
import { ident } from './harness/settings.js';
import { everyTable, reachableRelations } from './isolation/catalogue.js';
import { inSequence } from './isolation/detectors.js';
import type { FixtureUser } from './isolation/fixture.js';
import { comparable } from './isolation/routes.js';
import {
  apiConfig,
  type Call,
  type Environment,
  type Reply,
  request,
  type RunningApi,
  startApi,
  startEnvironment,
} from './support/api.js';
import { type LocalIdp, startIdp } from './support/idp.js';

// Export and deletion of a dashboard user's personal data: GET /me/export and
// DELETE /me. U is a user with a canary string in each of its four personal fields,
// its issuer included, so U signs in at an identity provider of its own and calls an
// app of its own; that app shares the environment's database and Redis prefix. U is
// an editor in A, whose free-text columns hold the isolation fixture's canaries, and
// an owner in B next to B's owner.

let env: Environment;
let idpOfU: LocalIdp;
let apiOfU: RunningApi;

const canary = (): string => `canary${randomBytes(6).toString('hex')}`;
const canariesOfU = new Map([
  ['public.users.idp_issuer', canary()],
  ['public.users.idp_subject', canary()],
  ['public.users.email', canary()],
  ['public.users.name', canary()],
]);
const U: FixtureUser = {
  id: randomUUID(),
  issuer: `https://${canariesOfU.get('public.users.idp_issuer')}.example.test`,
  subject: canariesOfU.get('public.users.idp_subject')!,
  email: `${canariesOfU.get('public.users.email')}@example.test`,
  name: canariesOfU.get('public.users.name')!,
};

beforeAll(async () => {
  env = await startEnvironment('personal');
  idpOfU = await startIdp(U.issuer);
  apiOfU = await startApi(apiConfig(env.database.appUrl, idpOfU, 'personal-u', env.redisPrefix));
});

afterAll(async () => {
  await apiOfU?.close();
  await idpOfU?.close();
  await env?.close();
});

/**
 * The world's rows, then U and its memberships, editor in A and owner in B, and two
 * audit rows that name U: in A as the actor who created the flag search, and in B as
 * the member whose role B's owner changed.
 */
async function seedWithU(): Promise<void> {
  await env.world.seed(env.admin);
  const { fixture, people } = env.world;
  await env.admin.query(
    `INSERT INTO public.users (id, idp_issuer, idp_subject, email, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [U.id, U.issuer, U.subject, U.email, U.name],
  );
  await env.admin.query(
    `INSERT INTO public.memberships (tenant_id, user_id, role)
     VALUES ($1, $3, 'editor'), ($2, $3, 'owner')`,
    [fixture.tenantA, fixture.tenantB, U.id],
  );
  await env.admin.query(
    `INSERT INTO public.audit_log (tenant_id, actor_user_id, action, target, before, after, version)
     VALUES ($1, $3, 'flag.create', 'search', NULL, '{"enabled": false}', 1),
            ($2, $4, 'member.role', $5, '{"role": "editor"}', '{"role": "owner"}', NULL)`,
    [fixture.tenantA, fixture.tenantB, U.id, people.ownerOfB.id, U.id],
  );
}

/** The audit rows that name U as actor or target. */
function auditRowsOfU(rows: readonly AuditRow[]): AuditRow[] {
  return rows.filter((row) => row.row.includes(U.id));
}

let tokenOfU: Promise<string> | undefined;

/** Sends call as U to U's app, with a token that is valid for an hour. */
function asU(call: Call): Promise<Reply> {
  tokenOfU ??= idpOfU.token(U.subject, { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } });
  return tokenOfU.then((token) => request(apiOfU.base, call, `Bearer ${token}`));
}

const EXPORT: Call = { method: 'GET', path: '/me/export' };
const DELETE_ME: Call = { method: 'DELETE', path: '/me' };

/** The names of the canaries that text holds, sorted. */
function canariesIn(text: string, canaries: ReadonlyMap<string, string>): string[] {
  return [...canaries]
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name)
    .toSorted();
}

interface Rows {
  n: number;
  sum: string;
}

/**
 * The count and checksum, xmin included, of each table's rows on the superuser
 * connection, leaving out the rows that except gives for a table.
 */
async function everyRow(except: Readonly<Record<string, string>> = {}): Promise<Map<string, Rows>> {
  const row = `t.xmin::text || ' ' || t::text`;
  const sums = await inSequence(await everyTable(env.admin), async (table) => {
    const left = except[table.name];
    const { rows } = await env.admin.query<Rows>(
      `SELECT count(*)::int AS n,
              md5(coalesce(string_agg(${row}, E'\\n' ORDER BY ${row}), '')) AS sum
       FROM ${table.name} t WHERE ${left === undefined ? 'true' : `NOT (${left})`}`,
    );
    return [table.name, rows[0] as Rows] as const;
  });
  return new Map(sums);
}

/** U's rows: its users row, its memberships, and the audit rows written after lastAuditId. */
function rowsOfU(lastAuditId: string): Record<string, string> {
  return {
    'public.users': `t.id = '${U.id}'`,
    'public.memberships': `t.user_id = '${U.id}'`,
    'public.audit_log': `t.id > ${BigInt(lastAuditId)}`,
  };
}

interface AuditRow {
  id: string;
  xmin: string;
  row: string;
}

/** The last id that audit_log's identity sequence gave out, committed or not. */
async function lastAuditIdTaken(): Promise<bigint> {
  const { rows } = await env.admin.query<{ last: string }>(
    `SELECT pg_catalog.pg_sequence_last_value(
              pg_catalog.pg_get_serial_sequence('public.audit_log', 'id')::regclass)::text AS last`,
  );
  return BigInt(rows[0]!.last);
}

async function auditRows(): Promise<AuditRow[]> {
  const { rows } = await env.admin.query<AuditRow>(
    'SELECT a.id::text AS id, a.xmin::text AS xmin, a::text AS row FROM public.audit_log a ORDER BY a.id',
  );
  return rows;
}

/**
 * Every text and JSON column of every table, read on the superuser connection, that
 * holds one of the canaries, as "table.column: canary name", and the columns the scan
 * read, as "table.column", sorted.
 */
async function databaseCanaries(
  admin: pg.ClientBase,
  canaries: ReadonlyMap<string, string>,
): Promise<{ hits: string[]; columns: string[] }> {
  const columns = (await everyTable(admin)).flatMap((table) =>
    table.columns
      .filter((column) => column.freeText)
      .map((column) => ({ table: table.name, column: column.name })),
  );
  const hits = await inSequence(columns, async ({ table, column }) => {
    const { rows } = await admin.query<{ name: string }>(
      `SELECT c.name FROM unnest($1::text[], $2::text[]) AS c (name, canary)
       WHERE EXISTS (
         SELECT FROM ${table} t WHERE pg_catalog.strpos(t.${ident(column)}::text, c.canary) > 0
       )
       ORDER BY c.name`,
      [[...canaries.keys()], [...canaries.values()]],
    );
    return rows.map((found) => `${table}.${column}: ${found.name}`);
  });
  return {
    hits: hits.flat().toSorted(),
    columns: columns.map(({ table, column }) => `${table}.${column}`).toSorted(),
  };
}

/**
 * The text and JSON columns of every base table outside the system schemas, read from
 * information_schema rather than from the catalogue query the scan uses, as
 * "table.column", sorted.
 */
async function textAndJsonColumns(admin: pg.ClientBase): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT pg_catalog.format('%I.%I', c.table_schema, c.table_name) || '.' || c.column_name
              AS name
     FROM information_schema.columns c
     JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
     WHERE t.table_type = 'BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND c.table_schema !~ '^pg_(toast|temp_)'
       AND (c.data_type IN ('text', 'character varying', 'character', 'name', 'json', 'jsonb', 'xml')
            OR (c.data_type = 'ARRAY'
                AND c.udt_name IN ('_text', '_varchar', '_bpchar', '_name', '_json', '_jsonb', '_xml')))`,
  );
  return rows.map((row) => row.name).toSorted();
}

/**
 * Every key under prefix whose name or value holds one of the canaries, as
 * "key: canary name", and how many values the scan read.
 */
async function redisCanaries(
  redis: Redis,
  prefix: string,
  canaries: ReadonlyMap<string, string>,
): Promise<{ hits: string[]; values: number }> {
  const hits: string[] = [];
  let values = 0;
  for await (const keys of redis.scanIterator({ MATCH: `${escapeGlob(prefix)}:*`, COUNT: 500 })) {
    const read = await inSequence(keys, async (key) => ({ key, value: await redis.get(key) }));
    for (const { key, value } of read) {
      if (value === null) continue;
      values += 1;
      hits.push(...canariesIn(`${key}\n${value}`, canaries).map((name) => `${key}: ${name}`));
    }
  }
  return { hits: hits.toSorted(), values };
}

/** Columns of users that the export does not account for, and entries that name no column. */
function exportCoverageFindings(columns: readonly string[]): string[] {
  const exported = Object.keys(USER_EXPORT_FIELDS);
  const excluded = Object.keys(USER_EXPORT_EXCLUDED);
  return [
    ...columns
      .filter((column) => !exported.includes(column) && !excluded.includes(column))
      .map((column) => `${column}: is neither in the export nor on the exclusion list`),
    ...[...exported, ...excluded]
      .filter((column) => !columns.includes(column))
      .map((column) => `${column}: is listed but is not a column of users`),
    ...exported
      .filter((column) => excluded.includes(column))
      .map((column) => `${column}: is both exported and excluded`),
  ];
}

async function usersColumns(admin: pg.ClientBase): Promise<string[]> {
  const { relations } = await reachableRelations(admin, 'rff_app');
  const users = relations.find((relation) => relation.name === 'public.users');
  return users?.columns.map((column) => column.name) ?? [];
}

describe('personal data', () => {
  it("GET /me/export returns the user's own data and nobody else's", async () => {
    await seedWithU();
    const { fixture, people } = env.world;
    const reply = await asU(EXPORT);
    expect(reply.status).toBe(200);
    const [a, b] = fixture.tenants;
    expect(reply.body).toEqual({
      user: { id: U.id, issuer: U.issuer, subject: U.subject, email: U.email, name: U.name },
      memberships: [
        { tenantId: a!.id, slug: a!.slug, name: a!.name, role: 'editor' },
        { tenantId: b!.id, slug: b!.slug, name: b!.name, role: 'owner' },
      ].toSorted((x, y) => (x.slug < y.slug ? -1 : 1)),
    });
    expect(canariesIn(reply.text, canariesOfU)).toEqual([...canariesOfU.keys()].toSorted());
    // U's membership in A names A by its slug and name, which are canaries of A.
    expect(canariesIn(reply.text, fixture.canaries)).toEqual([
      'public.tenants.name',
      'public.tenants.slug',
    ]);
    const { rows: others } = await env.admin.query<{ fields: string[] }>(
      `SELECT ARRAY[idp_issuer, idp_subject, email, name] AS fields FROM public.users
       WHERE id <> $1`,
      [U.id],
    );
    expect(others).toHaveLength(7);
    const shown = others.flatMap(({ fields }) =>
      fields.filter((field) => reply.text.includes(field)),
    );
    expect(shown).toEqual([]);

    const signable = [
      people.shared,
      people.editorOfA,
      people.viewerOfA,
      people.ownerOfB,
      people.editorOfB,
      people.outsider,
    ];
    const exports = await inSequence(signable, (user) => env.send(user, EXPORT));
    expect(
      exports.map((other) => ({
        status: other.status,
        id: (other.body as { user?: { id?: string } }).user?.id,
        canariesOfU: canariesIn(other.text, canariesOfU),
      })),
    ).toEqual(signable.map((user) => ({ status: 200, id: user.id, canariesOfU: [] })));
  });

  it('every users column is in the export', async () => {
    await seedWithU();
    const columns = await usersColumns(env.admin);
    expect(columns).toEqual(['id', 'idp_issuer', 'idp_subject', 'email', 'name']);
    expect(exportCoverageFindings(columns)).toEqual([]);
    expect(USER_EXPORT_EXCLUDED).toEqual({});
    const reply = await asU(EXPORT);
    const { user } = reply.body as { user: Record<string, string> };
    const { rows } = await env.admin.query<{ row: Record<string, string> }>(
      'SELECT to_jsonb(u) AS row FROM public.users u WHERE id = $1',
      [U.id],
    );
    const stored = rows[0]!.row;
    expect(
      Object.entries(USER_EXPORT_FIELDS).map(([column, field]) => [column, user[field]]),
    ).toEqual(columns.map((column) => [column, stored[column]]));

    // Control: on a migrated database whose users table has one more column, the
    // same check names it.
    const scratch = await createMigratedDatabase('personalcols');
    const admin = await connectClient(scratch.adminUrl, 'rff-test-personal');
    try {
      await admin.query('ALTER TABLE public.users ADD COLUMN phone text');
      expect(exportCoverageFindings(await usersColumns(admin))).toEqual([
        'phone: is neither in the export nor on the exclusion list',
      ]);
    } finally {
      await admin.end();
    }
  });

  it('DELETE /me erases U and changes no other row', async () => {
    await seedWithU();
    const { fixture } = env.world;
    const auditBefore = await auditRows();
    expect(auditRowsOfU(auditBefore)).toHaveLength(2);
    const lastId = auditBefore.at(-1)!.id;
    const before = await everyRow(rowsOfU(lastId));

    const reply = await asU(DELETE_ME);
    expect({ status: reply.status, text: reply.text }).toEqual({ status: 204, text: '' });

    const { rows: users } = await env.admin.query(
      `SELECT id, idp_issuer, idp_subject, email, name, xmin::text AS xmin
       FROM public.users WHERE id = $1`,
      [U.id],
    );
    expect(users).toEqual([
      {
        id: U.id,
        idp_issuer: null,
        idp_subject: null,
        email: null,
        name: null,
        xmin: expect.any(String),
      },
    ]);
    const { rows: memberships } = await env.admin.query(
      'SELECT tenant_id FROM public.memberships WHERE user_id = $1',
      [U.id],
    );
    expect(memberships).toEqual([]);

    const auditAfter = await auditRows();
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    const { rows: added } = await env.admin.query(
      `SELECT tenant_id, actor_user_id, action, target, before, after, version,
              xmin::text AS xmin
       FROM public.audit_log WHERE id > $1 ORDER BY tenant_id`,
      [lastId],
    );
    const left = (tenantId: string, role: string) => ({
      tenant_id: tenantId,
      actor_user_id: U.id,
      action: 'member.leave',
      target: U.id,
      before: { role },
      after: null,
      version: null,
      // One transaction wrote the audit rows and erased the user.
      xmin: users[0].xmin,
    });
    expect(added).toEqual(
      [left(fixture.tenantA, 'editor'), left(fixture.tenantB, 'owner')].toSorted((x, y) =>
        x.tenant_id < y.tenant_id ? -1 : 1,
      ),
    );
    expect(auditAfter).toHaveLength(auditBefore.length + 2);
    expect([...(await everyRow(rowsOfU(lastId)))]).toEqual([...before]);
  });

  it('after DELETE /me no scan finds a canary of U', async () => {
    await seedWithU();
    const { fixture } = env.world;
    // Snapshots of U's tenants in the cache, read through U's app.
    const reads = await inSequence([fixture.tenantA, fixture.tenantB], (tenantId) =>
      asU({ method: 'GET', path: `/tenants/${tenantId}/flags` }),
    );
    expect(reads.map((read) => read.status)).toEqual([200, 200]);
    const runPrefix = harness().redisPrefix;

    const inDatabase = await databaseCanaries(env.admin, canariesOfU);
    expect(inDatabase.hits).toEqual(
      [...canariesOfU.keys()].map((column) => `${column}: ${column}`).toSorted(),
    );
    // The scan read every text and JSON column that information_schema lists: today
    // the 13 of the tenant tables and the name and checksum of schema_migrations.
    expect(inDatabase.columns).toEqual(await textAndJsonColumns(env.admin));
    expect(inDatabase.columns).toHaveLength(15);
    const inRedis = await redisCanaries(env.redis, runPrefix, canariesOfU);
    expect(inRedis.hits).toEqual([]);
    expect(inRedis.values).toBeGreaterThanOrEqual(2);
    // Control: a cache entry holding U's email is found.
    const tenantId = randomUUID();
    const planted = `${env.redisPrefix}:flags:${tenantId}:v1`;
    await env.redis.set(
      planted,
      JSON.stringify({ tenantId, version: 1, flags: [], note: U.email }),
    );
    try {
      expect((await redisCanaries(env.redis, runPrefix, canariesOfU)).hits).toEqual([
        `${planted}: public.users.email`,
      ]);
    } finally {
      await env.redis.del(planted);
    }

    expect((await asU(DELETE_ME)).status).toBe(204);
    expect((await databaseCanaries(env.admin, canariesOfU)).hits).toEqual([]);
    expect((await redisCanaries(env.redis, runPrefix, canariesOfU)).hits).toEqual([]);
  });

  it("after DELETE /me U's valid token is refused", async () => {
    await seedWithU();
    const me: Call = { method: 'GET', path: '/me' };
    expect((await asU(me)).status).toBe(200);
    expect((await asU(DELETE_ME)).status).toBe(204);
    const unknown = await idpOfU.token(`nobody-${randomUUID()}`);
    const refusal = await request(apiOfU.base, me, `Bearer ${unknown}`);
    expect(refusal.status).toBe(401);
    const replies = await inSequence([me, EXPORT, DELETE_ME], (call) => asU(call));
    expect(replies.map(comparable)).toEqual(replies.map(() => comparable(refusal)));

    const silent = { log: () => {}, warn: () => {}, error: () => {} };
    const pool = createPool({ url: env.database.appUrl, poolMax: 1, connectDeadlineMs: 0 }, silent);
    try {
      const handlers = new MeController(new TenantDatabase(pool));
      const calls = [
        () => handlers.me(U.id),
        () => handlers.export(U.id),
        () => handlers.remove(U.id),
      ];
      const outcomes = await inSequence(calls, (call) =>
        call().then(
          () => 'answered',
          (error: unknown) => (error instanceof UnauthorizedException ? 401 : String(error)),
        ),
      );
      expect(outcomes).toEqual([401, 401, 401]);
    } finally {
      await pool.end();
    }
  });

  it('DELETE /me by an only owner gets 409 and changes nothing', async () => {
    await seedWithU();
    const { fixture } = env.world;
    // U leaves its tenants in id order. It is the only owner of the later one, and
    // can leave the earlier one, as an editor of A or one of B's two owners.
    const last = [fixture.tenantA, fixture.tenantB].toSorted()[1]!;
    await env.admin.query(
      `UPDATE public.memberships
       SET role = CASE WHEN user_id = $2 THEN 'owner' ELSE 'editor' END::public.member_role
       WHERE tenant_id = $1 AND (user_id = $2 OR role = 'owner')`,
      [last, U.id],
    );
    const before = await everyRow();
    const lastIdBefore = await lastAuditIdTaken();

    const reply = await asU(DELETE_ME);
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({
      message: `the only owner of tenant ${last} cannot leave it`,
    });
    // The audit row of the first tenant took one id from the sequence, which a
    // rollback does not give back, and the rollback removed it with every other change.
    expect(await lastAuditIdTaken()).toBe(lastIdBefore + 1n);
    expect([...(await everyRow())]).toEqual([...before]);
    expect((await asU({ method: 'GET', path: '/me' })).status).toBe(200);
  });

  it('two DELETE /me by U at once get 204 and 401', async () => {
    await seedWithU();
    const lastId = (await auditRows()).at(-1)!.id;
    // A lock on U's users row, held on another connection, stops both deletions at
    // their first statement, which locks that row.
    const blocker = await connectClient(env.database.adminUrl, 'rff-test-blocker');
    let waiting = false;
    let replies: Reply[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT FROM public.users WHERE id = $1 FOR UPDATE', [U.id]);
      const pending = Promise.all([asU(DELETE_ME), asU(DELETE_ME)]);
      waiting = await lockWaiters(2, 3000);
      await blocker.query('COMMIT');
      replies = await pending;
    } finally {
      await blocker.end();
    }
    expect(waiting).toBe(true);
    expect(replies.map((reply) => reply.status).toSorted()).toEqual([204, 401]);
    const { rows } = await env.admin.query<{ action: string }>(
      'SELECT action FROM public.audit_log WHERE id > $1',
      [lastId],
    );
    expect(rows).toEqual([{ action: 'member.leave' }, { action: 'member.leave' }]);
  });

  it('two members of A and B deleting themselves at once both get 204', async () => {
    await seedWithU();
    const { fixture, people } = env.world;
    // U is an editor of A and an owner of B; A's editor becomes a viewer of B.
    await env.admin.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [fixture.tenantB, people.editorOfA.id],
    );
    // Locks on both tenants' rows, held on another connection, stop both deletions at
    // the first tenant they enter.
    const blocker = await connectClient(env.database.adminUrl, 'rff-test-blocker');
    let waiting = false;
    let replies: Reply[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT FROM public.tenants WHERE id = ANY ($1::uuid[]) FOR UPDATE', [
        [fixture.tenantA, fixture.tenantB],
      ]);
      const pending = Promise.all([asU(DELETE_ME), env.send(people.editorOfA, DELETE_ME)]);
      waiting = await lockWaiters(2, 3000);
      await blocker.query('COMMIT');
      replies = await pending;
    } finally {
      await blocker.end();
    }
    expect(waiting).toBe(true);
    expect(replies.map((reply) => reply.status)).toEqual([204, 204]);
    const { rows } = await env.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.memberships WHERE user_id = ANY ($1::uuid[])',
      [[U.id, people.editorOfA.id]],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("B's two owners deleting themselves at once get 204 and 409", async () => {
    await seedWithU();
    const { fixture, people } = env.world;
    // A lock on B's row, held on another connection, stops both deletions inside their
    // transactions. Released together, they run one after the other only because each
    // takes that lock before it counts B's owners.
    const blocker = await connectClient(env.database.adminUrl, 'rff-test-blocker');
    let waiting = false;
    let replies: Reply[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT FROM public.tenants WHERE id = $1 FOR UPDATE', [fixture.tenantB]);
      const pending = Promise.all([asU(DELETE_ME), env.send(people.ownerOfB, DELETE_ME)]);
      waiting = await lockWaiters(2, 3000);
      await blocker.query('COMMIT');
      replies = await pending;
    } finally {
      await blocker.end();
    }
    expect(waiting).toBe(true);
    expect(replies.map((reply) => reply.status).toSorted()).toEqual([204, 409]);
    const { rows } = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.memberships WHERE tenant_id = $1 AND role = 'owner'`,
      [fixture.tenantB],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

/** Polls until count of rff_app's sessions on the database wait for a lock, or deadlineMs passed. */
async function lockWaiters(count: number, deadlineMs: number): Promise<boolean> {
  const end = performance.now() + deadlineMs;
  while (performance.now() < end) {
    // eslint-disable-next-line no-await-in-loop -- polling, one check at a time
    const { rows } = await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND usename = 'rff_app' AND wait_event_type = 'Lock'`,
      [env.database.name],
    );
    if (rows[0]?.n === count) return true;
    // eslint-disable-next-line no-await-in-loop -- the pause between two checks
    await sleep(20);
  }
  return false;
}
