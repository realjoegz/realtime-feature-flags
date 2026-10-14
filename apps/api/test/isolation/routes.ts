import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type INestApplication } from '@nestjs/common';
import type { AccessLevel } from '../../src/auth/access.js';
import type { Call, Environment, Reply, World } from '../support/api.js';
import { databaseSnapshot } from '../support/snapshots.js';
import { openStream } from '../support/sse.js';
import type { FixtureUser } from './fixture.js';
import { type Finding, inSequence } from './detectors.js';

// Tenant isolation at the routes. The routes come from the running app's HTTP
// router, and each one must have a case here or be on the public allow-list. A case
// is one request that an A member makes in A and must succeed; a member of B makes
// exactly the same request and must be refused with the same answer as a request
// for a tenant that does not exist. Where the route names a resource, a member of B
// asking in B for a resource that exists only in A must get the same answer as for
// a resource that exists nowhere.

/** METHOD /path, as Express lists it, for example GET /tenants/:tenantId/flags. */
export type RouteName = string;

export interface RouteCase {
  readonly route: RouteName;
  readonly access: AccessLevel;
  /** The status of a successful call. */
  readonly status: number;
  /** The call in tenantId, naming resource id where the route has one. */
  readonly call: (tenantId: string, id: string) => Call;
  /** For a route with a resource: an id that exists only in A, and one that exists nowhere. */
  readonly ids?: { readonly onlyInA: (world: World) => string; readonly missing: () => string };
  /** Role matrix cells whose status the access level alone does not give, with the reason. */
  readonly matrix?: Partial<
    Record<MatrixActor, { readonly status: number; readonly reason: string }>
  >;
}

/** GET /me is about the caller, not a tenant: each user sees only itself. */
export const SELF_ROUTE = 'GET /me';

/**
 * The routes about the caller and no tenant: GET /me, and the export and deletion of
 * the caller's personal data. Each user reads and erases only its own.
 */
export const SELF_ROUTES: readonly RouteName[] = [SELF_ROUTE, 'GET /me/export', 'DELETE /me'];

/**
 * A route whose tenant is the SDK key's, so no request names another tenant: with
 * B's key, A's request is B's own. Its cases are in isolation-routes.test.ts: A's
 * key receives A's snapshot alone, B's key nothing of A, and every caller without
 * an unrevoked key the same 401.
 */
export interface SdkKeyRouteCase {
  readonly route: RouteName;
  readonly access: 'sdk-key';
  readonly status: number;
  readonly call: () => Call;
}

export const STREAM_ROUTE = 'GET /sdk/stream';

export const SDK_KEY_ROUTES: readonly SdkKeyRouteCase[] = [
  {
    route: STREAM_ROUTE,
    access: 'sdk-key',
    status: 200,
    call: () => ({ method: 'GET', path: '/sdk/stream' }),
  },
];

export interface StreamOutcome {
  readonly findings: Finding[];
  /** Everything sent to B's key and to the callers that must be refused. */
  readonly repliesToOthers: { route: string; reply: { readonly text: string } }[];
  /** Everything sent to A's key. */
  readonly ownText: string;
}

/**
 * GET /sdk/stream for A's key, B's key and callers without an unrevoked key. Each
 * key's first event must be the snapshot of its own tenant exactly as the database
 * holds it, and every other caller must get the same 401 as a request with no key.
 */
export async function streamFindings(env: Environment): Promise<StreamOutcome> {
  const { fixture, people } = env.world;
  const findings: Finding[] = [];
  const finding = (detail: string): void => {
    findings.push({ relation: STREAM_ROUTE, detail });
  };
  const repliesToOthers: StreamOutcome['repliesToOthers'] = [];

  const firstEvent = async (name: string, key: string, tenantId: string): Promise<string> => {
    const stream = await openStream(env.api.base, { authorization: `Bearer ${key}` });
    try {
      if (stream.status !== 200) {
        finding(`${name} got ${stream.status}`);
        return (await stream.reply()).text;
      }
      await stream.until(() => stream.events.length > 0, `the first event for ${name}`);
      const expected = await databaseSnapshot(env.admin, tenantId);
      const [event] = stream.events;
      const own =
        event?.type === 'snapshot' &&
        event.lastEventId === String(expected.version) &&
        isDeepStrictEqual(JSON.parse(event.data), expected);
      if (!own) finding(`${name} did not receive the snapshot of its own tenant`);
      return stream.text;
    } finally {
      stream.close();
    }
  };
  const ownText = await firstEvent("A's key", fixture.sdkKeys.aActive.key, fixture.tenantA);
  repliesToOthers.push({
    route: STREAM_ROUTE,
    reply: { text: await firstEvent("B's key", fixture.sdkKeys.bActive.key, fixture.tenantB) },
  });

  const refused: [string, string | undefined][] = [
    ['no key', undefined],
    ["A's revoked key", `Bearer ${fixture.sdkKeys.aRevoked.key}`],
    ['an unknown key', `Bearer rff_sdk_${randomBytes(32).toString('base64url')}`],
    ['a key one character short', `Bearer ${fixture.sdkKeys.aActive.key.slice(0, -1)}`],
    ["A's key without the Bearer scheme", fixture.sdkKeys.aActive.key],
    ["the token of A's owner", await env.authorization(people.shared)],
  ];
  const answers = await inSequence(refused, async ([name, authorization]) => {
    const stream = await openStream(
      env.api.base,
      authorization === undefined ? {} : { authorization },
    );
    if (stream.status === 200) {
      // A stream was opened for a caller that should have none: keep what it sent.
      await stream
        .until(() => stream.events.length > 0, `an event for ${name}`, 2000)
        .catch(() => {});
      stream.close();
      finding(`${name} got 200`);
      repliesToOthers.push({ route: STREAM_ROUTE, reply: { text: stream.text } });
      return null;
    }
    const reply = await stream.reply();
    repliesToOthers.push({ route: STREAM_ROUTE, reply });
    return { name, reply };
  });
  const [noKey] = answers;
  if (noKey === null || noKey === undefined || noKey.reply.status !== 401) {
    finding('a request with no key did not get 401');
  }
  for (const answer of answers.slice(1)) {
    if (answer !== null && noKey && comparable(answer.reply) !== comparable(noKey.reply)) {
      finding(
        `${answer.name} got ${comparable(answer.reply)}, but no key got ${comparable(noKey.reply)}`,
      );
    }
  }
  return { findings, repliesToOthers, ownText };
}

/** Routes that need no token, each with its reason and the call that reaches it. */
export const PUBLIC_ROUTES: Readonly<Record<RouteName, { reason: string; call: Call }>> = {
  'GET /health': {
    reason: 'the compose healthcheck and scripts/demo.sh call it; it returns the instance name',
    call: { method: 'GET', path: '/health' },
  },
};

const tenantPath = (tenantId: string, rest: string): string => `/tenants/${tenantId}${rest}`;

/** The flag key that only A has; checkout and search exist in both tenants. */
export function flagOnlyInA(world: World): string {
  const key = world.fixture.canaries.get('public.flags.key');
  if (key === undefined) throw new Error('the fixture has no flag key canary');
  return key;
}

const flagIds = { onlyInA: flagOnlyInA, missing: () => `missing-${randomUUID().slice(0, 8)}` };

export const ROUTE_CASES: readonly RouteCase[] = [
  {
    route: SELF_ROUTE,
    access: 'signed-in',
    status: 200,
    call: () => ({ method: 'GET', path: '/me' }),
  },
  {
    route: 'GET /me/export',
    access: 'signed-in',
    status: 200,
    call: () => ({ method: 'GET', path: '/me/export' }),
  },
  {
    route: 'DELETE /me',
    access: 'signed-in',
    status: 204,
    call: () => ({ method: 'DELETE', path: '/me' }),
    matrix: { owner: { status: 409, reason: "the owner of A is A's only owner" } },
  },
  {
    route: 'GET /tenants/:tenantId/flags',
    access: 'viewer',
    status: 200,
    call: (tenant) => ({ method: 'GET', path: tenantPath(tenant, '/flags') }),
  },
  {
    route: 'GET /tenants/:tenantId/flags/:flagKey',
    access: 'viewer',
    status: 200,
    call: (tenant, key) => ({ method: 'GET', path: tenantPath(tenant, `/flags/${key}`) }),
    ids: flagIds,
  },
  {
    route: 'POST /tenants/:tenantId/flags',
    access: 'editor',
    status: 201,
    call: (tenant) => ({
      method: 'POST',
      path: tenantPath(tenant, '/flags'),
      body: { key: 'route-case', enabled: true, rules: [], rolloutBasisPoints: 100 },
    }),
  },
  {
    route: 'PUT /tenants/:tenantId/flags/:flagKey',
    access: 'editor',
    status: 200,
    call: (tenant, key) => ({
      method: 'PUT',
      path: tenantPath(tenant, `/flags/${key}`),
      body: { enabled: false, rules: [], rolloutBasisPoints: 1 },
    }),
    ids: flagIds,
  },
  {
    route: 'DELETE /tenants/:tenantId/flags/:flagKey',
    access: 'editor',
    status: 200,
    call: (tenant, key) => ({ method: 'DELETE', path: tenantPath(tenant, `/flags/${key}`) }),
    ids: flagIds,
  },
  {
    route: 'POST /tenants/:tenantId/evaluate',
    access: 'viewer',
    status: 200,
    call: (tenant) => ({
      method: 'POST',
      path: tenantPath(tenant, '/evaluate'),
      body: { key: 'user-1', attributes: { plan: 'pro', country: 'NL' } },
    }),
  },
  {
    route: 'GET /tenants/:tenantId/audit',
    access: 'viewer',
    status: 200,
    call: (tenant) => ({ method: 'GET', path: tenantPath(tenant, '/audit') }),
  },
  {
    route: 'GET /tenants/:tenantId/members',
    access: 'viewer',
    status: 200,
    call: (tenant) => ({ method: 'GET', path: tenantPath(tenant, '/members') }),
  },
  {
    route: 'PUT /tenants/:tenantId/members/:userId',
    access: 'owner',
    status: 200,
    call: (tenant, userId) => ({
      method: 'PUT',
      path: tenantPath(tenant, `/members/${userId}`),
      body: { role: 'editor' },
    }),
    ids: { onlyInA: (world) => world.people.viewerOfA.id, missing: () => randomUUID() },
  },
  {
    route: 'POST /tenants/:tenantId/sdk-keys',
    access: 'owner',
    status: 201,
    call: (tenant) => ({ method: 'POST', path: tenantPath(tenant, '/sdk-keys') }),
  },
];

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route the app's HTTP router serves, read from Express's own route table. */
export function servedRoutes(app: INestApplication): RouteName[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  return express.router.stack
    .flatMap((layer) =>
      layer.route === undefined
        ? []
        : Object.keys(layer.route.methods)
            .filter((method) => method !== '_all')
            .map((method) => `${method.toUpperCase()} ${layer.route?.path}`),
    )
    .toSorted();
}

/**
 * Every served route has a case or is on the public allow-list, every case and
 * allow-list entry names a served route, and no route is in both.
 */
export function routeTableFindings(
  served: readonly RouteName[],
  cases: readonly { readonly route: RouteName }[],
  publicRoutes: Readonly<Record<RouteName, unknown>>,
): Finding[] {
  const findings: Finding[] = [];
  const finding = (relation: string, detail: string): void => {
    findings.push({ relation, detail });
  };
  const caseRoutes = cases.map((routeCase) => routeCase.route);
  const listed = new Set([...caseRoutes, ...Object.keys(publicRoutes)]);
  for (const route of served) {
    if (!listed.has(route))
      finding(route, 'is served but has no case and is not public: add a case');
  }
  for (const route of listed) {
    if (!served.includes(route)) finding(route, 'has a case or allow-list entry but is not served');
  }
  for (const route of caseRoutes) {
    if (route in publicRoutes) finding(route, 'is both public and in the case table');
  }
  for (const route of new Set(caseRoutes)) {
    if (caseRoutes.filter((other) => other === route).length > 1) finding(route, 'has two cases');
  }
  return findings.toSorted((x, y) => (x.relation < y.relation ? -1 : 1));
}

/** A reply as compared between two requests: everything but the Date header. */
export function comparable(reply: Reply): string {
  const { date: _date, ...headers } = reply.headers;
  return JSON.stringify({ status: reply.status, headers, body: reply.text });
}

export interface PairOutcome {
  readonly findings: Finding[];
  /** Every reply that a member of B, or no member of A, received. */
  readonly repliesToOthers: Reply[];
}

/**
 * The B side of each tenant case: ownerOfB (owner in B, not in A) makes the A
 * member's request unchanged, the same request for a tenant that does not exist,
 * and, where the route names a resource, the request in B for a resource only A has
 * and for one that exists nowhere. All of them must give one and the same refusal.
 */
export async function refusalFindings(
  env: Environment,
  routeCase: RouteCase,
  memberOfB: FixtureUser,
): Promise<PairOutcome> {
  const { tenantA, tenantB } = env.world.fixture;
  const id = routeCase.ids?.onlyInA(env.world) ?? '';
  const asA = routeCase.call(tenantA, id);
  const sends: [string, Call][] = [
    ["A's request", asA],
    ['the same request for a tenant that does not exist', routeCase.call(randomUUID(), id)],
  ];
  if (routeCase.ids !== undefined) {
    sends.push(
      ['the request in B for a resource only A has', routeCase.call(tenantB, id)],
      [
        'the request in B for a resource that does not exist',
        routeCase.call(tenantB, routeCase.ids.missing()),
      ],
    );
  }
  const replies = await inSequence(sends, ([, call]) => env.send(memberOfB, call));
  const findings: Finding[] = [];
  const [first] = replies;
  if (first !== undefined && first.status < 400) {
    findings.push({
      relation: routeCase.route,
      detail: `a member of B made A's request and got ${first.status}`,
    });
  }
  replies.forEach((reply, index) => {
    if (index > 0 && first !== undefined && comparable(reply) !== comparable(first)) {
      findings.push({
        relation: routeCase.route,
        detail: `${sends[index]?.[0]} got ${comparable(reply)}, but A's request got ${comparable(first)}`,
      });
    }
  });
  return { findings, repliesToOthers: replies };
}

/** The canaries of A found in replies, one finding per reply and canary. */
export function canaryReplyFindings(
  replies: readonly { route: string; reply: { readonly text: string } }[],
  canaries: ReadonlyMap<string, string>,
): Finding[] {
  return replies.flatMap(({ route, reply }) =>
    [...canaries].flatMap(([column, canary]) =>
      reply.text.includes(canary)
        ? [
            {
              relation: route,
              detail: `a reply to someone outside A holds the canary of ${column}`,
            },
          ]
        : [],
    ),
  );
}

/** The users of the role matrix, from no token to the owner of A. */
export type MatrixActor = 'no token' | 'non-member' | 'viewer' | 'editor' | 'owner';

export const MATRIX_ACTORS: readonly MatrixActor[] = [
  'no token',
  'non-member',
  'viewer',
  'editor',
  'owner',
];

export function matrixUser(world: World, actor: MatrixActor): FixtureUser | null {
  const { people } = world;
  switch (actor) {
    case 'no token':
      return null;
    case 'non-member':
      return people.outsider;
    case 'viewer':
      return people.viewerOfA;
    case 'editor':
      return people.editorOfA;
    case 'owner':
      return people.shared;
  }
}

const RANK: Readonly<Record<MatrixActor, number>> = {
  'no token': -1,
  'non-member': 0,
  viewer: 1,
  editor: 2,
  owner: 3,
};

/** The status an actor gets from a route with access level, given the success status. */
export function expectedStatus(access: AccessLevel, success: number, actor: MatrixActor): number {
  if (access === 'public') return success;
  if (actor === 'no token') return 401;
  // A user's token is not an SDK key, whatever the user's role.
  if (access === 'sdk-key') return 401;
  if (access === 'signed-in') return success;
  if (actor === 'non-member') return 404;
  return RANK[actor] >= RANK[access] ? success : 403;
}
