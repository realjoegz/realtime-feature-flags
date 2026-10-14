import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type pg from 'pg';
import { createApp } from '../../src/app.js';
import { AppModule } from '../../src/app.module.js';
import { type Config } from '../../src/config.js';
import { connectClient } from '../../src/database/connect.js';
import { createMigratedDatabase, type MigratedDatabase } from '../harness/context.js';
import { createFixture, type Fixture, type FixtureUser } from '../isolation/fixture.js';
import { AUDIENCE, type LocalIdp, startIdp } from './idp.js';

// The API as the tests run it: a migrated database of its own, the isolation fixture
// (tenants A and B) plus two users that fixture lacks, the local identity provider,
// and the Nest app listening on 127.0.0.1 with rff_app's credentials.

export function apiConfig(
  databaseUrl: string,
  auth: { issuer: string; jwksUrl: string },
  instance = 'api-test',
): Config {
  return {
    http: { host: '127.0.0.1', port: 0 },
    instance,
    database: { url: databaseUrl, poolMax: 4, connectDeadlineMs: 5000 },
    auth: { ...auth, audience: AUDIENCE },
    stream: { heartbeatMs: 15_000 },
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
  close(): Promise<void>;
}

export async function listen(app: INestApplication): Promise<RunningApi> {
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
  const { port } = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
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
    return listen(await createApp(configured, { logger: false }));
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
  return listen(moduleRef.createNestApplication({ logger: false, forceCloseConnections: true }));
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
  /** Empties every tenant table and inserts the fixture's rows and the extra users. */
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
  readonly api: RunningApi;
  readonly world: World;
  /** Sends call as user (null: no Authorization header) and reads the whole reply. */
  send(user: FixtureUser | null, call: Call): Promise<Reply>;
  /** Sends call with this Authorization header value. */
  sendWith(authorization: string | undefined, call: Call): Promise<Reply>;
  /** The Authorization header value that send uses for user. */
  authorization(user: FixtureUser): Promise<string>;
  close(): Promise<void>;
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

/** A migrated database seeded with the world, the local identity provider and the API. */
export async function startEnvironment(
  label: string,
  changes: AppChanges = {},
): Promise<Environment> {
  const database = await createMigratedDatabase(label);
  const admin = await connectClient(database.adminUrl, 'rff-test-api');
  const world = createWorld();
  await world.seed(admin);
  const idp = await startIdp(world.fixture.users.shared.issuer);
  let api: RunningApi;
  try {
    api = await startApi(apiConfig(database.appUrl, idp), changes, world);
  } catch (error) {
    await idp.close();
    await admin.end();
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
  return {
    database,
    admin,
    idp,
    api,
    world,
    async send(user, call) {
      return request(api.base, call, user === null ? undefined : `Bearer ${await tokenFor(user)}`);
    },
    sendWith: (authorization, call) => request(api.base, call, authorization),
    authorization: async (user) => `Bearer ${await tokenFor(user)}`,
    async close() {
      try {
        await api.close();
      } finally {
        await idp.close();
        await admin.end();
      }
    },
  };
}
