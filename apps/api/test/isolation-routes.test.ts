import { randomUUID } from 'node:crypto';
import { Controller, Get, NotFoundException } from '@nestjs/common';
import type { Flag } from '@rff/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access } from '../src/auth/access.js';
import type { MemberScope } from '../src/auth/request-auth.js';
import { FlagsService } from '../src/flags/flags.service.js';
import { FLAGS_NOTIFIER, type FlagsNotifier } from '../src/flags/notifier.js';
import { PG_POOL } from '../src/tokens.js';
import { TenantDatabase, type MemberRole } from '../src/database/tenant-database.js';
import { reachableRelations, type Relation } from './isolation/catalogue.js';
import { type Finding, inSequence, visibleRowSums } from './isolation/detectors.js';
import { tenancyRule } from './isolation/fixture.js';
import {
  canaryReplyFindings,
  expectedStatus,
  MATRIX_ACTORS,
  matrixUser,
  PUBLIC_ROUTES,
  refusalFindings,
  ROUTE_CASES,
  routeTableFindings,
  SDK_KEY_ROUTES,
  SELF_ROUTE,
  servedRoutes,
  STREAM_ROUTE,
  streamFindings,
} from './isolation/routes.js';
import { type Environment, type Reply, startEnvironment } from './support/api.js';
import { databaseSnapshot } from './support/snapshots.js';
import { openStream } from './support/sse.js';

// Tenant isolation at the routes, the second half of the isolation proof (the first
// is isolation-tables.test.ts). The detectors live in isolation/routes.ts; the
// controls at the end run them against apps that leak and pass only when they
// report it.

let env: Environment;
let relations: readonly Relation[];

beforeAll(async () => {
  env = await startEnvironment('isoroutes');
  ({ relations } = await reachableRelations(env.admin, 'rff_app'));
});

afterAll(async () => {
  await env?.close();
});

function describeFindings(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.relation}: ${finding.detail}`);
}

const tenantCases = ROUTE_CASES.filter((routeCase) => routeCase.route !== SELF_ROUTE);

/** A's rows in every table rff_app reaches, with their xmin, on the superuser connection. */
function rowsOfA(target: Environment = env) {
  return visibleRowSums(
    target.admin,
    relations,
    (relation) => tenancyRule(relation),
    target.world.fixture.contexts.A,
  );
}

/**
 * Every request a member of B makes in the pair checks, and the A member's request
 * after them. Returns the findings and every reply that went to someone outside A.
 */
async function pairChecks(target: Environment): Promise<{
  findings: Finding[];
  replies: { route: string; reply: Reply }[];
  aStatuses: Record<string, number>;
}> {
  const findings: Finding[] = [];
  const replies: { route: string; reply: Reply }[] = [];
  const aStatuses: Record<string, number> = {};
  const { people, fixture } = target.world;
  await inSequence(tenantCases, async (routeCase) => {
    await target.world.seed(target.admin);
    const before = await rowsOfA(target);
    const outcome = await refusalFindings(target, routeCase, people.ownerOfB);
    const after = await rowsOfA(target);
    findings.push(...outcome.findings);
    for (const [name, rows] of before) {
      if (after.get(name)?.sum !== rows.sum) {
        findings.push({
          relation: routeCase.route,
          detail: `requests by a member of B changed A's rows in ${name}`,
        });
      }
    }
    replies.push(...outcome.repliesToOthers.map((reply) => ({ route: routeCase.route, reply })));
    const id = routeCase.ids?.onlyInA(target.world) ?? '';
    const asA = await target.send(people.shared, routeCase.call(fixture.tenantA, id));
    aStatuses[routeCase.route] = asA.status;
  });
  return { findings, replies, aStatuses };
}

describe('tenant isolation at the routes', () => {
  it("the routes the app's HTTP router serves are exactly the case table plus the public allow-list, GET /health", () => {
    const served = servedRoutes(env.api.app);
    expect(
      describeFindings(
        routeTableFindings(served, [...ROUTE_CASES, ...SDK_KEY_ROUTES], PUBLIC_ROUTES),
      ),
    ).toEqual([]);
    expect(Object.keys(PUBLIC_ROUTES)).toEqual(['GET /health']);
    expect(SDK_KEY_ROUTES.map((routeCase) => routeCase.route)).toEqual([STREAM_ROUTE]);
    expect(served).toHaveLength(13);
  });

  it('each case: a member of A succeeds in A, and a member of B making the same request is refused exactly as for a tenant or resource that does not exist', async () => {
    const { findings, aStatuses } = await pairChecks(env);
    expect(describeFindings(findings)).toEqual([]);
    expect(aStatuses).toEqual(
      Object.fromEntries(tenantCases.map((routeCase) => [routeCase.route, routeCase.status])),
    );
  });

  it("requests by members of B and by a user in no tenant change none of A's rows, xmin included, and no reply to them holds a canary of A", async () => {
    const { fixture, people } = env.world;
    await env.world.seed(env.admin);
    const before = await rowsOfA();
    const replies: { route: string; reply: Reply }[] = [];
    // Every case as the owner of B, the editor of B and the user in no tenant, in A,
    // in B with A's resource ids, and in a tenant that does not exist.
    for (const routeCase of tenantCases) {
      const id = routeCase.ids?.onlyInA(env.world) ?? '';
      for (const user of [people.ownerOfB, people.editorOfB, people.outsider]) {
        for (const tenant of [fixture.tenantA, fixture.tenantB, randomUUID()]) {
          // eslint-disable-next-line no-await-in-loop -- one request at a time, in order
          const reply = await env.send(user, routeCase.call(tenant, id));
          replies.push({ route: routeCase.route, reply });
        }
      }
    }
    // GET /me as users outside A: each sees only itself.
    for (const user of [people.ownerOfB, people.editorOfB, people.outsider]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, in order
      const reply = await env.send(user, { method: 'GET', path: '/me' });
      expect(reply.status).toBe(200);
      expect((reply.body as { id: string }).id).toBe(user.id);
      replies.push({ route: SELF_ROUTE, reply });
    }
    const after = await rowsOfA();
    expect([...after]).toEqual([...before]);
    expect(describeFindings(canaryReplyFindings(replies, fixture.canaries))).toEqual([]);
    // The check can see a canary: A's own replies hold them.
    const own = await env.send(people.shared, ROUTE_CASES[1]!.call(fixture.tenantA, ''));
    expect(canaryReplyFindings([{ route: 'A', reply: own }], fixture.canaries)).not.toEqual([]);
  });

  it("the shared user, owner in A and viewer in B, reads B's flags, members and audit with no canary of A, and GET /me gives each user only its own tenants", async () => {
    const { fixture, people } = env.world;
    await env.world.seed(env.admin);
    const replies = await inSequence(['/flags', '/members', '/audit'], async (rest) => {
      const reply = await env.send(people.shared, {
        method: 'GET',
        path: `/tenants/${fixture.tenantB}${rest}`,
      });
      expect(reply.status).toBe(200);
      return { route: rest, reply };
    });
    expect(describeFindings(canaryReplyFindings(replies, fixture.canaries))).toEqual([]);

    const tenantsOf = async (user: typeof people.shared) => {
      const reply = await env.send(user, { method: 'GET', path: '/me' });
      const body = reply.body as {
        id: string;
        memberships: { tenantId: string; role: MemberRole }[];
      };
      return { id: body.id, memberships: body.memberships.map((m) => [m.tenantId, m.role]) };
    };
    const [a, b] = fixture.tenants;
    expect(await tenantsOf(people.shared)).toEqual({
      id: people.shared.id,
      memberships: [
        [a!.id, 'owner'],
        [b!.id, 'viewer'],
      ],
    });
    expect(await tenantsOf(people.editorOfA)).toEqual({
      id: people.editorOfA.id,
      memberships: [[a!.id, 'editor']],
    });
    expect(await tenantsOf(people.ownerOfB)).toEqual({
      id: people.ownerOfB.id,
      memberships: [[b!.id, 'owner']],
    });
    expect(await tenantsOf(people.outsider)).toEqual({ id: people.outsider.id, memberships: [] });
  });

  it('role matrix: every route for no token, a user in no tenant, and a viewer, an editor and the owner of A', async () => {
    const { fixture } = env.world;
    const routes = [
      ...ROUTE_CASES.map((routeCase) => ({
        route: routeCase.route,
        access: routeCase.access,
        status: routeCase.status,
        call: routeCase.call(fixture.tenantA, routeCase.ids?.onlyInA(env.world) ?? ''),
      })),
      ...SDK_KEY_ROUTES.map((routeCase) => ({
        route: routeCase.route,
        access: routeCase.access,
        status: routeCase.status,
        call: routeCase.call(),
      })),
      ...Object.entries(PUBLIC_ROUTES).map(([route, { call }]) => ({
        route,
        access: 'public' as const,
        status: 200,
        call,
      })),
    ];
    const cells = routes.flatMap((route) => MATRIX_ACTORS.map((actor) => ({ route, actor })));
    const actual = await inSequence(cells, async ({ route, actor }) => {
      // A write that succeeded in one cell must not decide the next one.
      if (route.call.method !== 'GET') await env.world.seed(env.admin);
      const reply = await env.send(matrixUser(env.world, actor), route.call);
      return `${route.route} as ${actor}: ${reply.status}`;
    });
    const expected = cells.map(
      ({ route, actor }) =>
        `${route.route} as ${actor}: ${expectedStatus(route.access, route.status, actor)}`,
    );
    expect(actual).toEqual(expected);
    expect(cells).toHaveLength(13 * 5);
  });

  it("the SDK stream: A's key receives A's snapshot as the database holds it, B's key receives B's with no canary of A, and A's revoked key, an unknown key, a key one character short, A's key without the Bearer scheme and the token of A's owner get the same 401 as no key", async () => {
    await env.world.seed(env.admin);
    const before = await rowsOfA();
    const { findings, repliesToOthers, ownText } = await streamFindings(env);
    expect(describeFindings(findings)).toEqual([]);
    expect(repliesToOthers).toHaveLength(7);
    expect(
      describeFindings(canaryReplyFindings(repliesToOthers, env.world.fixture.canaries)),
    ).toEqual([]);
    // The canary check sees A's canaries in what A's key received.
    expect(
      canaryReplyFindings([{ route: 'A', reply: { text: ownText } }], env.world.fixture.canaries),
    ).not.toEqual([]);
    expect([...(await rowsOfA())]).toEqual([...before]);
  });

  it("the SDK stream: a change in A reaches A's open streams and none of B's, and the next event on B's stream is B's own change", async () => {
    const { fixture, people } = env.world;
    await env.world.seed(env.admin);
    const ofA = await openStream(env.api.base, {
      authorization: `Bearer ${fixture.sdkKeys.aActive.key}`,
    });
    const ofB = await openStream(env.api.base, {
      authorization: `Bearer ${fixture.sdkKeys.bActive.key}`,
    });
    try {
      await ofA.until(() => ofA.events.length === 1, "A's snapshot");
      await ofB.until(() => ofB.events.length === 1, "B's snapshot");
      const put = (tenantId: string, rolloutBasisPoints: number) =>
        env.send(tenantId === fixture.tenantA ? people.shared : people.ownerOfB, {
          method: 'PUT',
          path: `/tenants/${tenantId}/flags/checkout`,
          body: { enabled: true, rules: [], rolloutBasisPoints },
        });
      // A changes first, then B, then A twice more.
      const versions = await inSequence(
        [fixture.tenantA, fixture.tenantB, fixture.tenantA, fixture.tenantA],
        async (tenantId) => ((await put(tenantId, 1234)).body as { version: number }).version,
      );
      expect(versions).toEqual([4, 2, 5, 6]);
      await ofA.until(() => ofA.events.at(-1)?.lastEventId === '6', "A's version 6");
      await ofB.until(() => ofB.events.length === 2, "B's change");
      expect(ofB.events.map((event) => event.lastEventId)).toEqual(['1', '2']);
      expect(JSON.parse(ofB.events[1]!.data)).toEqual(
        await databaseSnapshot(env.admin, fixture.tenantB),
      );
      expect(JSON.parse(ofA.events.at(-1)!.data)).toEqual(
        await databaseSnapshot(env.admin, fixture.tenantA),
      );
      expect(canaryReplyFindings([{ route: STREAM_ROUTE, reply: ofB }], fixture.canaries)).toEqual(
        [],
      );
    } finally {
      ofA.close();
      ofB.close();
    }
  });

  it("control: an app whose SDK key look-up gives A's tenant for every key is reported by the stream check, which finds A's snapshot on B's key, a stream for A's revoked key and for an unknown key, and A's canaries in what they received", async () => {
    const leaky = await startEnvironment('isokeys', {
      override: (builder, world) =>
        builder.overrideProvider(TenantDatabase).useFactory({
          factory: (pool: pg.Pool) => new EveryKeyIsA(pool, world.fixture.tenantA),
          inject: [PG_POOL],
        }),
    });
    try {
      const { findings, repliesToOthers } = await streamFindings(leaky);
      expect(describeFindings(findings)).toEqual([
        `${STREAM_ROUTE}: B's key did not receive the snapshot of its own tenant`,
        `${STREAM_ROUTE}: A's revoked key got 200`,
        `${STREAM_ROUTE}: an unknown key got 200`,
      ]);
      // B's key, the revoked key and the unknown key each received A's flag key, salt
      // and rule value.
      const leaks = canaryReplyFindings(repliesToOthers, leaky.world.fixture.canaries);
      expect(leaks.map((leak) => leak.detail.replace(/^.* canary of /, '')).toSorted()).toEqual(
        ['public.flags.key', 'public.flags.rules', 'public.flags.salt'].flatMap((column) => [
          column,
          column,
          column,
        ]),
      );
    } finally {
      await leaky.close();
    }
  });

  it('control: an app with one route that has no case, and a case for a route the app does not serve, are reported', async () => {
    const extra = await startEnvironment('isoextra', { controllers: [ExtraController] });
    try {
      const removed = { ...tenantCases[0]!, route: 'GET /tenants/:tenantId/removed' };
      expect(
        describeFindings(
          routeTableFindings(
            servedRoutes(extra.api.app),
            [...ROUTE_CASES, ...SDK_KEY_ROUTES, removed],
            PUBLIC_ROUTES,
          ),
        ),
      ).toEqual([
        'GET /tenants/:tenantId/extra: is served but has no case and is not public: add a case',
        'GET /tenants/:tenantId/removed: has a case or allow-list entry but is not served',
      ]);
    } finally {
      await extra.close();
    }
  });

  it("control: an app whose membership look-up ignores the path's tenant is reported by every pair, by A's checksum and by the canary check", async () => {
    const leaky = await startEnvironment('isoleaky', {
      override: (builder) =>
        builder
          .overrideProvider(TenantDatabase)
          .useFactory({ factory: (pool: pg.Pool) => new AnyTenantRole(pool), inject: [PG_POOL] }),
    });
    try {
      const { findings, replies } = await pairChecks(leaky);
      const details = describeFindings(findings);
      for (const routeCase of tenantCases) {
        expect(details).toContain(
          `${routeCase.route}: a member of B made A's request and got ${routeCase.status}`,
        );
      }
      const changedA = new Set(
        findings
          .filter((finding) =>
            finding.detail.startsWith("requests by a member of B changed A's rows"),
          )
          .map((finding) => finding.relation),
      );
      expect([...changedA].toSorted()).toEqual(
        tenantCases
          .filter((routeCase) => ['POST', 'PUT', 'DELETE'].includes(routeCase.call('', '').method))
          .filter((routeCase) => routeCase.route !== 'POST /tenants/:tenantId/evaluate')
          .map((routeCase) => routeCase.route)
          .toSorted(),
      );
      expect(canaryReplyFindings(replies, leaky.world.fixture.canaries).length).toBeGreaterThan(0);
    } finally {
      await leaky.close();
    }
  });

  it('control: an app that answers a flag missing from the tenant with a 404 of its own is reported by the pair check, which compares whole replies and not only statuses', async () => {
    const oracle = await startEnvironment('isooracle', {
      override: (builder) =>
        builder.overrideProvider(FlagsService).useFactory({
          factory: (db: TenantDatabase, notifier: FlagsNotifier) =>
            new FlagsWithOwnNotFound(db, notifier),
          inject: [TenantDatabase, FLAGS_NOTIFIER],
        }),
    });
    try {
      const { findings, replies } = await pairChecks(oracle);
      const route = 'GET /tenants/:tenantId/flags/:flagKey';
      // Every reply to B for this route is a 404: only the body, and the content-length
      // and ETag headers that follow from it, tell the missing flag from the refusal.
      expect(replies.filter((r) => r.route === route).map((r) => r.reply.status)).toEqual([
        404, 404, 404, 404,
      ]);
      expect(describeFindings(findings).map((detail) => detail.replace(/ got .*$/s, ''))).toEqual([
        `${route}: the request in B for a resource only A has`,
        `${route}: the request in B for a resource that does not exist`,
      ]);
    } finally {
      await oracle.close();
    }
  });
});

@Controller('tenants/:tenantId')
class ExtraController {
  @Get('extra')
  @Access('viewer')
  extra(): string {
    return 'extra';
  }
}

/** A broken look-up: tenant A for every SDK key, known, unknown or revoked. */
class EveryKeyIsA extends TenantDatabase {
  constructor(
    pool: pg.Pool,
    private readonly tenantA: string,
  ) {
    super(pool);
  }

  override async tenantIdForSdkKeyHash(keyHash: Uint8Array): Promise<string | null> {
    void keyHash;
    return this.tenantA;
  }
}

/** A broken look-up: the user's role in the first tenant it belongs to, whatever the path says. */
class AnyTenantRole extends TenantDatabase {
  override async memberRole(userId: string, tenantId: string): Promise<MemberRole | null> {
    void tenantId;
    return (await this.membershipsOf(userId))[0]?.role ?? null;
  }
}

/**
 * A broken flag read: a flag that is not in the tenant gets a 404 with its own
 * message, so a member of B can tell it from the refusal of a tenant it is not in.
 */
class FlagsWithOwnNotFound extends FlagsService {
  override async get(member: MemberScope, key: string): Promise<Flag> {
    try {
      return await super.get(member, key);
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException('No such flag');
      throw error;
    }
  }
}
