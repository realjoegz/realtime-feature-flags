import { randomBytes, randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type pg from 'pg';
import { createApp } from '../../src/app.js';
import { AppModule } from '../../src/app.module.js';
import { type Config } from '../../src/config.js';
import { connectClient } from '../../src/database/connect.js';
import { createMigratedDatabase, harness, type MigratedDatabase } from '../harness/context.js';
import { connectRedis, type Redis, removeKeysWithPrefix } from '../harness/redis.js';
import { createFixture, type Fixture, type FixtureUser } from '../isolation/fixture.js';
import { AUDIENCE, type LocalIdp, startIdp } from './idp.js';

// The API as the tests run it: a migrated database of its own, the isolation fixture
// (tenants A and B) plus two users that fixture lacks, the local identity provider,
// and one or more Nest apps listening on 127.0.0.1 with rff_app's credentials. The
// apps of one environment share its database and a Redis prefix of its own, as the
// replicas of one deployment do.

/** A Redis prefix under this run's, for one environment or app. */
export function redisPrefixFor(label: string): string {
  return `${harness().redisPrefix}:${label}-${randomBytes(3).toString('hex')}`;
}

export function apiConfig(
  databaseUrl: string,
  auth: { issuer: string; jwksUrl: string },
  instance = 'api-test',
  redisPrefix = redisPrefixFor('app'),
): Config {
  return {
    http: { host: '127.0.0.1', port: 0 },
    instance,
    // Two connections per app: most environments run two apps, and test files run in
    // parallel, so concurrent test runs share the server's connection limit.
    database: { url: databaseUrl, poolMax: 2, connectDeadlineMs: 5000 },
    auth: { ...auth, audience: AUDIENCE },
    stream: { heartbeatMs: 15_000, safetyPollMs: 5000 },
    redis: { url: harness().redisUrl, prefix: redisPrefix, connectDeadlineMs: 5000 },
  };
}

/** For tests that never send a token: no key set is fetched from this address. */
export const UNUSED_AUTH = {
  issuer: 'https://idp.example.test',
  jwksUrl: 'http://127.0.0.1:9/keys',
};

export interface RunningApi {
  readonly app: INestApplication;
  readonly base: string;
  /** The instance name in the app's configuration. */
  readonly instance: string;
  close(): Promise<void>;
}

export async function listen(app: INestApplication, instance = 'api-test'): Promise<RunningApi> {
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
  const { port } = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${port}`, instance, close: () => app.close() };
}

export interface AppChanges {
  /**
   * Replaces providers of the app, for a control that leaks or a recording notifier.
   * In startEnvironment it also gets the seeded world.
   */
  readonly override?: (builder: TestingModuleBuilder, world: World) => TestingModuleBuilder;
  /** Controllers added next to the app's own. */
  readonly controllers?: readonly (new (...args: never[]) => unknown)[];
  /** Changes to the configuration, such as a shorter heartbeat interval. */
  readonly configure?: (config: Config) => Config;
}

/** The app as createApp builds it, or as a testing module with the changes applied. */
export async function startApi(
  config: Config,
  changes: AppChanges = {},
  world?: World,
): Promise<RunningApi> {
  const configured = changes.configure?.(config) ?? config;
  if (changes.override === undefined && changes.controllers === undefined) {
    return listen(await createApp(configured, { logger: false }), configured.instance);
  }
  const builder = Test.createTestingModule({
    imports: [AppModule.forRoot(configured)],
    controllers: [...(changes.controllers ?? [])],
  });
  if (changes.override !== undefined && world === undefined) {
    throw new Error('startApi: an override needs the world; use startEnvironment');
  }
  const changed = world === undefined ? builder : (changes.override?.(builder, world) ?? builder);
  const moduleRef = await changed.compile();
  return listen(
    moduleRef.createNestApplication({ logger: false, forceCloseConnections: true }),
    configured.instance,
  );
}

/** The fixture's users by what they can do. Each one can sign in except where noted. */
export interface People {
  /** Owner in A and viewer in B. */
  readonly shared: FixtureUser;
  /** Editor in A only. */
  readonly editorOfA: FixtureUser;
  /** Viewer in A only. */
  readonly viewerOfA: FixtureUser;
  /** Owner in B only. */
  readonly ownerOfB: FixtureUser;
  /** Editor in B only. */
  readonly editorOfB: FixtureUser;
  /** In no tenant. */
  readonly outsider: FixtureUser;
  /** Editor in A whose issuer, subject, email and name are canaries; cannot sign in. */
  readonly canaryEditorOfA: FixtureUser;
}

export interface World {
  readonly fixture: Fixture;
  readonly people: People;
  /**
   * Empties every tenant table and inserts the fixture's rows and the extra users.
   * In an environment it also empties the environment's cache: the seed sets the
   * versions back, and an entry for a version that is written again would not
   * hold that version's flags.
   */
  seed(admin: pg.ClientBase): Promise<void>;
}

function extraUser(label: string, issuer: string): FixtureUser {
  const tag = `${label}-${randomUUID().slice(0, 8)}`;
  return {
    id: randomUUID(),
    issuer,
    subject: tag,
    email: `${tag}@example.test`,
    name: `User ${tag}`,
  };
}

/**
 * The isolation fixture's A editor holds canaries in its issuer and subject, so no
 * token names it. The world adds an editor of A that can sign in, and an owner of B,
 * so that every role exists in both tenants.
 */
export function createWorld(): World {
  const fixture = createFixture();
  const { issuer } = fixture.users.shared;
  const editorOfA = extraUser('a-editor', issuer);
  const ownerOfB = extraUser('b-owner', issuer);
  const people: People = {
    shared: fixture.users.shared,
    editorOfA,
    viewerOfA: fixture.users.aViewer,
    ownerOfB,
    editorOfB: fixture.users.bEditor,
    outsider: fixture.users.nobody,
    canaryEditorOfA: fixture.users.aEditor,
  };
  return {
    fixture,
    people,
    async seed(admin) {
      await fixture.seed(admin);
      await admin.query(
        `INSERT INTO public.users (id, idp_issuer, idp_subject, email, name)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [
          [editorOfA.id, ownerOfB.id],
          [editorOfA.issuer, ownerOfB.issuer],
          [editorOfA.subject, ownerOfB.subject],
          [editorOfA.email, ownerOfB.email],
          [editorOfA.name, ownerOfB.name],
        ],
      );
      await admin.query(
        `INSERT INTO public.memberships (tenant_id, user_id, role)
         VALUES ($1, $2, 'editor'), ($3, $4, 'owner')`,
        [fixture.tenantA, editorOfA.id, fixture.tenantB, ownerOfB.id],
      );
    },
  };
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly body: unknown;
}

export interface Call {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

export interface Environment {
  readonly database: MigratedDatabase;
  /** Superuser on the environment's database. */
  readonly admin: pg.Client;
  readonly idp: LocalIdp;
  /** The first app; apis holds every one, in the order of the changes. */
  readonly api: RunningApi;
  readonly apis: readonly RunningApi[];
  readonly world: World;
  /** A Redis connection of the test's own. */
  readonly redis: Redis;
  /** The prefix every key and channel of the environment's apps starts with, before ":". */
  readonly redisPrefix: string;
  /**
   * Sends call as user (null: no Authorization header) to apis[via], default the
   * first, and reads the whole reply.
   */
  send(user: FixtureUser | null, call: Call, via?: number): Promise<Reply>;
  /** Sends call with this Authorization header value. */
  sendWith(authorization: string | undefined, call: Call, via?: number): Promise<Reply>;
  /** The Authorization header value that send uses for user. */
  authorization(user: FixtureUser): Promise<string>;
  /** Deletes every key of the environment's apps, for a test that changes versions directly. */
  clearCache(): Promise<void>;
  /**
   * Closes the apps and the connections. With clearCache, it then deletes the apps'
   * keys: a control whose cache writes keys that are not tenant-scoped entries uses
   * it, since the run's teardown reports any such key (harness/redis-keys.ts).
   */
  close(options?: { readonly clearCache?: boolean }): Promise<void>;
}

export async function request(base: string, call: Call, authorization?: string): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${call.path}`, {
    method: call.method,
    headers,
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, body };
}

/**
 * A migrated database seeded with the world, the local identity provider and the
 * API: one app, or one for each entry when changes is a list.
 */
export async function startEnvironment(
  label: string,
  changes: AppChanges | readonly AppChanges[] = {},
): Promise<Environment> {
  const perApp: readonly AppChanges[] = Array.isArray(changes) ? changes : [changes];
  const database = await createMigratedDatabase(label);
  const admin = await connectClient(database.adminUrl, 'rff-test-api');
  const redisPrefix = redisPrefixFor(label);
  const redis = await connectRedis(harness().redisUrl);
  const clearCache = async (): Promise<void> => {
    await removeKeysWithPrefix(redis, `${redisPrefix}:`);
  };
  const base = createWorld();
  const world: World = {
    ...base,
    async seed(client) {
      await base.seed(client);
      await clearCache();
    },
  };
  await world.seed(admin);
  const idp = await startIdp(world.fixture.users.shared.issuer);
  const apis: RunningApi[] = [];
  try {
    for (const [index, appChanges] of perApp.entries()) {
      const config = apiConfig(database.appUrl, idp, `${label}-${index + 1}`, redisPrefix);
      // eslint-disable-next-line no-await-in-loop -- one app after another, in order
      apis.push(await startApi(config, appChanges, world));
    }
  } catch (error) {
    await Promise.allSettled(apis.map((api) => api.close()));
    await idp.close();
    await admin.end();
    redis.destroy();
    throw error;
  }
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (user: FixtureUser): Promise<string> => {
    let token = tokens.get(user.id);
    if (token === undefined) {
      // An hour, so that a token minted early in a long file is still valid at its end.
      token = idp.token(user.subject, { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } });
      tokens.set(user.id, token);
    }
    return token;
  };
  const baseOf = (via = 0): string => {
    const api = apis[via];
    if (api === undefined) throw new Error(`the environment has no app ${via}`);
    return api.base;
  };
  return {
    database,
    admin,
    idp,
    api: apis[0] as RunningApi,
    apis,
    world,
    redis,
    redisPrefix,
    async send(user, call, via) {
      const authorization = user === null ? undefined : `Bearer ${await tokenFor(user)}`;
      return request(baseOf(via), call, authorization);
    },
    sendWith: (authorization, call, via) => request(baseOf(via), call, authorization),
    authorization: async (user) => `Bearer ${await tokenFor(user)}`,
    clearCache,
    async close(options = {}) {
      try {
        await Promise.all(apis.map((api) => api.close()));
        if (options.clearCache === true) await clearCache();
      } finally {
        await idp.close();
        await admin.end();
        redis.destroy();
      }
    },
  };
}
