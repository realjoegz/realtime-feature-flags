import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectClient } from '../src/database/connect.js';
import { createPool } from '../src/database/pool.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import { inSequence } from './isolation/detectors.js';
import { type Call, type Environment, type Reply, startEnvironment } from './support/api.js';

// Members, SDK keys and GET /me.

let env: Environment;

beforeAll(async () => {
  env = await startEnvironment('members');
});

afterAll(async () => {
  await env?.close();
});

const membersOf = (tenantId: string): Call => ({
  method: 'GET',
  path: `/tenants/${tenantId}/members`,
});
const setRole = (tenantId: string, userId: string, body: unknown): Call => ({
  method: 'PUT',
  path: `/tenants/${tenantId}/members/${userId}`,
  body,
});

/** How many of rff_app's sessions on database wait for a lock. */
async function lockWaiters(database: string): Promise<number> {
  const { rows } = await env.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
     WHERE datname = $1 AND usename = 'rff_app' AND wait_event_type = 'Lock'`,
    [database],
  );
  return rows[0]?.n ?? 0;
}

/** Polls check until it is true or deadlineMs passed, and says which. */
async function waitFor(check: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = performance.now() + deadlineMs;
  while (performance.now() < end) {
    // eslint-disable-next-line no-await-in-loop -- polling, one check at a time
    if (await check()) return true;
    // eslint-disable-next-line no-await-in-loop -- the pause between two checks
    await sleep(20);
  }
  return false;
}

async function rolesInA(): Promise<Record<string, string>> {
  const { rows } = await env.admin.query<{ user_id: string; role: string }>(
    'SELECT user_id, role::text FROM public.memberships WHERE tenant_id = $1',
    [env.world.fixture.tenantA],
  );
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

describe('members', () => {
  it("GET /members lists the tenant's members with email, name and role, ordered by email", async () => {
    await env.world.seed(env.admin);
    const { people, fixture } = env.world;
    const reply = await env.send(people.viewerOfA, membersOf(fixture.tenantA));
    const expected = [
      [people.shared, 'owner'],
      [people.editorOfA, 'editor'],
      [people.viewerOfA, 'viewer'],
      [people.canaryEditorOfA, 'editor'],
    ] as const;
    expect(reply.body).toEqual({
      members: expected
        .map(([user, role]) => ({ userId: user.id, email: user.email, name: user.name, role }))
        .toSorted((x, y) => (x.email < y.email ? -1 : 1)),
    });
  });

  it('PUT /members/:userId changes the role of a member; a user who is not a member gives 404, and a body other than one known role gives 400, and neither changes a role', async () => {
    await env.world.seed(env.admin);
    const { people, fixture } = env.world;
    const owner = people.shared;
    const before = await rolesInA();
    const refused = await inSequence(
      [
        setRole(fixture.tenantA, people.editorOfB.id, { role: 'editor' }),
        setRole(fixture.tenantA, 'not-a-uuid', { role: 'editor' }),
        setRole(fixture.tenantA, people.viewerOfA.id, { role: 'admin' }),
        setRole(fixture.tenantA, people.viewerOfA.id, { role: 'editor', extra: 1 }),
        setRole(fixture.tenantA, people.viewerOfA.id, {}),
      ],
      (call) => env.send(owner, call),
    );
    expect(refused.map((reply) => reply.status)).toEqual([404, 404, 400, 400, 400]);
    expect(await rolesInA()).toEqual(before);

    const changed = await env.send(
      owner,
      setRole(fixture.tenantA, people.viewerOfA.id.toUpperCase(), { role: 'editor' }),
    );
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({
      member: {
        userId: people.viewerOfA.id,
        email: people.viewerOfA.email,
        name: people.viewerOfA.name,
        role: 'editor',
      },
    });
    expect(await rolesInA()).toEqual({ ...before, [people.viewerOfA.id]: 'editor' });
  });

  it('a tenant keeps an owner: demoting the only owner gives 409 and changes nothing, and two owners demoting each other at once leave exactly one owner', async () => {
    await env.world.seed(env.admin);
    const { people, fixture } = env.world;
    const alone = await env.send(
      people.shared,
      setRole(fixture.tenantA, people.shared.id, { role: 'viewer' }),
    );
    expect(alone.status).toBe(409);
    expect((await rolesInA())[people.shared.id]).toBe('owner');

    await env.admin.query(
      "UPDATE public.memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2",
      [fixture.tenantA, people.editorOfA.id],
    );
    // A lock on A's row, held on another connection, stops both requests inside their
    // transactions after the guard has let both owners through. Released together,
    // they run one after the other only if the route takes that lock itself.
    const blocker = await connectClient(env.database.adminUrl, 'rff-test-blocker');
    let waiting = false;
    let replies: Reply[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT FROM public.tenants WHERE id = $1 FOR UPDATE', [fixture.tenantA]);
      const pending = Promise.all([
        env.send(people.shared, setRole(fixture.tenantA, people.editorOfA.id, { role: 'editor' })),
        env.send(people.editorOfA, setRole(fixture.tenantA, people.shared.id, { role: 'editor' })),
      ]);
      waiting = await waitFor(async () => (await lockWaiters(env.database.name)) === 2, 3000);
      await blocker.query('COMMIT');
      replies = await pending;
    } finally {
      await blocker.end();
    }
    expect(waiting).toBe(true);
    expect(replies.map((reply) => reply.status).toSorted()).toEqual([200, 409]);
    const roles = await rolesInA();
    expect(Object.values(roles).filter((role) => role === 'owner')).toHaveLength(1);
  });
});

describe('SDK keys', () => {
  it('POST /sdk-keys returns rff_sdk_ and 32 random bytes in base64url once, stores only its SHA-256, and the SDK key look-up finds the tenant by that hash', async () => {
    await env.world.seed(env.admin);
    const { people, fixture } = env.world;
    const create = (): Promise<{ status: number; body: unknown }> =>
      env.send(people.shared, { method: 'POST', path: `/tenants/${fixture.tenantA}/sdk-keys` });
    const [first, second] = [await create(), await create()];
    const keys = [first, second].map(
      (reply) => reply.body as { id: string; key: string; createdAt: string },
    );
    expect([first.status, second.status]).toEqual([201, 201]);
    for (const created of keys) {
      expect(created.key).toMatch(/^rff_sdk_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(created.key.slice('rff_sdk_'.length), 'base64url')).toHaveLength(32);
      expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    }
    expect(keys[1]?.key).not.toBe(keys[0]?.key);

    const { rows } = await env.admin.query<{
      id: string;
      tenant_id: string;
      key_hash: Buffer;
      row: string;
    }>(
      `SELECT id, tenant_id, key_hash, k::text AS row FROM public.sdk_keys k WHERE id = ANY($1::uuid[])
       ORDER BY created_at, id`,
      [keys.map((key) => key.id)],
    );
    const pool = createPool(
      { url: env.database.appUrl, poolMax: 1, connectDeadlineMs: 0 },
      {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    );
    try {
      const db = new TenantDatabase(pool);
      for (const created of keys) {
        const hash = createHash('sha256').update(created.key).digest();
        const row = rows.find((candidate) => candidate.id === created.id);
        expect(row?.tenant_id).toBe(fixture.tenantA);
        expect(row?.key_hash.equals(hash)).toBe(true);
        expect(row?.row).not.toContain(created.key.slice('rff_sdk_'.length));
        // eslint-disable-next-line no-await-in-loop -- one connection, one look-up at a time
        expect(await db.tenantIdForSdkKeyHash(hash)).toBe(fixture.tenantA);
      }
    } finally {
      await pool.end();
    }
    // A later read of the tenant's data never shows a key again.
    const replies = await inSequence(['/audit', '/members', '/flags'], (rest) =>
      env.send(people.shared, { method: 'GET', path: `/tenants/${fixture.tenantA}${rest}` }),
    );
    for (const reply of replies) {
      for (const created of keys) expect(reply.text).not.toContain(created.key);
    }
  });
});

describe('GET /me', () => {
  it("returns the signed-in user's id, email and name, and each tenant it belongs to with slug, name and role", async () => {
    await env.world.seed(env.admin);
    const { people, fixture } = env.world;
    const [a] = fixture.tenants;
    const reply = await env.send(people.editorOfA, { method: 'GET', path: '/me' });
    expect(reply.body).toEqual({
      id: people.editorOfA.id,
      email: people.editorOfA.email,
      name: people.editorOfA.name,
      memberships: [{ tenantId: a!.id, slug: a!.slug, name: a!.name, role: 'editor' }],
    });
  });
});
