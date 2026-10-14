import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { AccessLevel } from '../../src/auth/access.js';
import type { Call, Environment, Reply, World } from '../support/api.js';
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
}

/** GET /me is about the caller, not a tenant: each user sees only itself. */
export const SELF_ROUTE = 'GET /me';

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
  cases: readonly RouteCase[],
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
  replies: readonly { route: string; reply: Reply }[],
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
  if (access === 'signed-in') return success;
  if (actor === 'non-member') return 404;
  return RANK[actor] >= RANK[access] ? success : 403;
}
