import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { createPool } from '../src/database/pool.js';
import { TenantDatabase, TRANSACTION_ENDED } from '../src/database/tenant-database.js';
import { adminClient, createMigratedDatabase, harness } from './harness/context.js';
import { createFixture, type Fixture } from './isolation/fixture.js';

// withTenant is the only way the API reads or writes tenant data. These tests run on
// the run's own database as rff_app; they need no tables, only the two settings.

const silent = { log: () => {}, warn: () => {}, error: () => {} };

async function withPool<T>(
  poolMax: number,
  fn: (db: TenantDatabase, pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const pool = createPool({ url: harness().appUrl, poolMax, connectDeadlineMs: 0 }, silent);
  try {
    return await fn(new TenantDatabase(pool), pool);
  } finally {
    await pool.end();
  }
}

interface Session {
  tenant: string | null;
  user: string | null;
  pid: number;
}

const SESSION = `
  SELECT pg_catalog.current_setting('app.tenant_id', true) AS tenant,
         pg_catalog.current_setting('app.user_id', true) AS user,
         pg_catalog.pg_backend_pid() AS pid`;

const XACT = `SELECT pg_catalog.pg_current_xact_id()::text AS xid`;

async function status(pool: pg.Pool, xid: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT pg_catalog.pg_xact_status($1::xid8) AS status',
    [xid],
  );
  return rows[0]?.status ?? 'unknown';
}

const nothing = async (): Promise<void> => {};

/** What a query that fn sent late saw, or the error that refused it. */
function outcome(query: Promise<pg.QueryResult<Session>>): Promise<string | null> {
  return query.then(
    ({ rows }) => `ran with app.tenant_id ${String(rows[0]?.tenant)}`,
    (error: Error) => error.message,
  );
}

const scope = () => ({ tenantId: randomUUID(), userId: randomUUID() });

describe('withTenant', () => {
  it('runs fn in one transaction on one connection with app.tenant_id and app.user_id set, and commits it', async () => {
    await withPool(1, async (db, pool) => {
      const wanted = scope();
      const seen = await db.withTenant(wanted, async (client) => {
        const first = (await client.query<{ xid: string }>(XACT)).rows[0]?.xid ?? '';
        const session = (await client.query<Session>(SESSION)).rows[0] as Session;
        const second = (await client.query<{ xid: string }>(XACT)).rows[0]?.xid ?? '';
        return { first, second, session };
      });
      expect(seen.second).toBe(seen.first);
      expect(seen.session).toMatchObject({ tenant: wanted.tenantId, user: wanted.userId });
      expect(await status(pool, seen.first)).toBe('committed');
      // A request made with an SDK key has no user.
      const sdk = await db.withTenant({ tenantId: wanted.tenantId, userId: null }, async (c) => {
        return (await c.query<Session>(SESSION)).rows[0] as Session;
      });
      expect(sdk).toMatchObject({ tenant: wanted.tenantId, user: '' });
    });
  });

  it('the settings end with the transaction: the reused connection reads none after a COMMIT or a ROLLBACK', async () => {
    await withPool(1, async (db, pool) => {
      const inside = await db.withTenant(scope(), async (client) => {
        return (await client.query<Session>(SESSION)).rows[0] as Session;
      });
      const afterCommit = (await pool.query<Session>(SESSION)).rows[0];
      expect(afterCommit).toEqual({ tenant: '', user: '', pid: inside.pid });

      const failure = new Error('fn failed');
      await expect(
        db.withTenant(scope(), async (client) => {
          await client.query(SESSION);
          throw failure;
        }),
      ).rejects.toBe(failure);
      const afterRollback = (await pool.query<Session>(SESSION)).rows[0];
      expect(afterRollback).toEqual({ tenant: '', user: '', pid: inside.pid });
      // What the policies compare tenant_id with on that connection.
      const { rows } = await pool.query<{ tenant: string | null }>(
        `SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid AS tenant`,
      );
      expect(rows).toEqual([{ tenant: null }]);
    });
  });

  it('control: a session-level set_config survives COMMIT and reaches the next use of the connection', async () => {
    await withPool(1, async (db, pool) => {
      const tenantId = randomUUID();
      await db.withTenant(scope(), async (client) => {
        await client.query(`SELECT pg_catalog.set_config('app.tenant_id', $1, false)`, [tenantId]);
      });
      const after = (await pool.query<Session>(SESSION)).rows[0];
      expect(after?.tenant).toBe(tenantId);
    });
  });

  it('rolls back and rethrows when fn throws or a statement fails, and returns the connection to the pool', async () => {
    await withPool(1, async (db, pool) => {
      let xid = '';
      let pid = 0;
      const failure = new Error('fn failed');
      await expect(
        db.withTenant(scope(), async (client) => {
          xid = (await client.query<{ xid: string }>(XACT)).rows[0]?.xid ?? '';
          pid = ((await client.query<Session>(SESSION)).rows[0] as Session).pid;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await status(pool, xid)).toBe('aborted');
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({ total: 1, idle: 1 });

      await expect(
        db.withTenant(scope(), async (client) => {
          await client.query('SELECT 1 / 0');
        }),
      ).rejects.toMatchObject({ code: '22012' });
      expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({ total: 1, idle: 1 });
      const next = await db.withTenant(scope(), async (client) => {
        return ((await client.query<Session>(SESSION)).rows[0] as Session).pid;
      });
      expect(next).toBe(pid);
    });
  });

  it('discards a connection that dies inside fn, and the next call gets a new one', async () => {
    await withPool(1, async (db, pool) => {
      let pid = 0;
      const admin = await adminClient();
      try {
        await expect(
          db.withTenant(scope(), async (client) => {
            pid = ((await client.query<Session>(SESSION)).rows[0] as Session).pid;
            await admin.query('SELECT pg_catalog.pg_terminate_backend($1)', [pid]);
            await client.query('SELECT 1');
          }),
        ).rejects.toThrow(/terminat|not queryable/);
      } finally {
        await admin.end();
      }
      expect(pool.totalCount).toBe(0);
      const next = await db.withTenant(scope(), async (client) => {
        return ((await client.query<Session>(SESSION)).rows[0] as Session).pid;
      });
      expect(next).not.toBe(pid);
    });
  });

  it("refuses a query that fn sends after it has returned or thrown, so the query never runs in the next caller's transaction", async () => {
    await withPool(1, async (db) => {
      // Each late query waits for a gate and then runs on fn's client, as a query that
      // fn forgot to await would. The gate opens inside the next call on the same
      // connection, which is where such a query would land.
      const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
      let afterReturn: Promise<string | null> = Promise.resolve(null);
      let afterThrow: Promise<string | null> = Promise.resolve(null);

      await db.withTenant(scope(), async (client) => {
        afterReturn = outcome(gate.then(() => client.query<Session>(SESSION)));
      });
      const failure = new Error('one branch failed');
      await expect(
        db.withTenant(scope(), async (client) => {
          afterThrow = outcome(gate.then(() => client.query<Session>(SESSION)));
          throw failure;
        }),
      ).rejects.toBe(failure);

      const next = scope();
      const seen = await db.withTenant(next, async (client) => {
        openGate();
        const late = await Promise.all([afterReturn, afterThrow]);
        const own = (await client.query<Session>(SESSION)).rows[0] as Session;
        return { late, own: own.tenant };
      });
      expect(seen).toEqual({ late: [TRANSACTION_ENDED, TRANSACTION_ENDED], own: next.tenantId });
    });
  });

  it('rejects a tenant id or user id that is not a UUID before taking a connection', async () => {
    await withPool(1, async (db, pool) => {
      await expect(db.withTenant({ tenantId: '', userId: null }, nothing)).rejects.toThrow(
        'withTenant: tenantId is not a UUID',
      );
      await expect(
        db.withTenant({ tenantId: `${randomUUID()}' OR true --`, userId: null }, nothing),
      ).rejects.toThrow('withTenant: tenantId is not a UUID');
      await expect(
        db.withTenant({ tenantId: randomUUID(), userId: 'me' }, nothing),
      ).rejects.toThrow('withTenant: userId is neither null nor a UUID');
      expect(pool.totalCount).toBe(0);
    });
  });

  it('concurrent calls on one pool each see only their own settings', async () => {
    await withPool(4, async (db) => {
      const scopes = Array.from({ length: 24 }, scope);
      const seen = await Promise.all(
        scopes.map((wanted) =>
          db.withTenant(wanted, async (client) => {
            await client.query('SELECT pg_catalog.pg_sleep(0.01)');
            const session = (await client.query<Session>(SESSION)).rows[0] as Session;
            return { tenantId: session.tenant, userId: session.user };
          }),
        ),
      );
      expect(seen).toEqual(scopes);
    });
  });
});

describe('look-ups before the tenant is known', () => {
  let fixture: Fixture;
  let appUrl: string;

  beforeAll(async () => {
    const database = await createMigratedDatabase('lookups');
    fixture = createFixture();
    const admin = await connectClient(database.adminUrl, 'rff-test-lookups');
    try {
      await fixture.seed(admin);
    } finally {
      await admin.end();
    }
    appUrl = database.appUrl;
  });

  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  it('the helper finds the user by issuer and subject, the member role and the tenant of an unrevoked SDK key, and returns null otherwise', async () => {
    pool = createPool({ url: appUrl, poolMax: 2, connectDeadlineMs: 0 }, silent);
    const db = new TenantDatabase(pool);
    const { shared, nobody } = fixture.users;
    const { aActive, aRevoked, bActive } = fixture.sdkKeys;

    expect(await db.userIdForSubject(shared.issuer, shared.subject)).toBe(shared.id);
    expect(await db.userIdForSubject(shared.issuer, `${shared.subject}x`)).toBeNull();

    expect(await db.memberRole(shared.id, fixture.tenantA)).toBe('owner');
    expect(await db.memberRole(shared.id, fixture.tenantB)).toBe('viewer');
    expect(await db.memberRole(nobody.id, fixture.tenantA)).toBeNull();
    // A route parameter that is not a UUID is an unknown tenant, not an error.
    expect(await db.memberRole(shared.id, 'not-a-uuid')).toBeNull();

    expect(await db.tenantIdForSdkKeyHash(aActive.hash)).toBe(fixture.tenantA);
    expect(await db.tenantIdForSdkKeyHash(bActive.hash)).toBe(fixture.tenantB);
    expect(await db.tenantIdForSdkKeyHash(aRevoked.hash)).toBeNull();
    expect(await db.tenantIdForSdkKeyHash(randomBytes(32))).toBeNull();
  });
});
