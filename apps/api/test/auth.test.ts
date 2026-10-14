import { randomUUID } from 'node:crypto';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access } from '../src/auth/access.js';
import { UndeclaredAccessError } from '../src/auth/route-access-check.js';
import { AppModule } from '../src/app.module.js';
import { inSequence } from './isolation/detectors.js';
import {
  apiConfig,
  type Call,
  type Environment,
  request,
  startApi,
  startEnvironment,
} from './support/api.js';
import { hmacToken, startIdp, unsignedToken } from './support/idp.js';
import { comparable } from './isolation/routes.js';

// Bearer tokens, users and roles. The tokens come from the local identity provider
// in support/idp.ts and go through the API's own verifier, which fetches the key set
// over HTTP as it does from Dex.

let env: Environment;

beforeAll(async () => {
  env = await startEnvironment('auth');
});

afterAll(async () => {
  await env?.close();
});

const ME: Call = { method: 'GET', path: '/me' };
const flags = (tenant: string): Call => ({ method: 'GET', path: `/tenants/${tenant}/flags` });
/** A read, a flag write that needs an editor and a key that needs an owner. */
const ownerCalls = (tenant: string): Call[] => [
  { method: 'GET', path: `/tenants/${tenant}/flags/checkout` },
  {
    method: 'PUT',
    path: `/tenants/${tenant}/flags/checkout`,
    body: { enabled: true, rules: [], rolloutBasisPoints: 5000 },
  },
  { method: 'POST', path: `/tenants/${tenant}/sdk-keys` },
];
const now = (): number => Math.floor(Date.now() / 1000);

describe('bearer tokens', () => {
  it("accepts RS256 and ES256 tokens from the configured issuer for the audience, including Dex's audience list, with the key set at a different address than the issuer", async () => {
    const { shared } = env.world.people;
    expect(new URL(env.idp.jwksUrl).origin).not.toBe(new URL(env.idp.issuer).origin);
    const tokens = [
      await env.idp.token(shared.subject, { key: 'rsa' }),
      await env.idp.token(shared.subject, { key: 'ec' }),
      // The key that the key set lists without "alg" verifies RS256, so the refusal of
      // RS384 and PS256 signed with it comes from the API's algorithm list.
      await env.idp.token(shared.subject, { key: 'unpinned' }),
      await env.idp.token(shared.subject, { claims: { aud: ['rff-api', 'rff-dashboard'] } }),
    ];
    const replies = await inSequence(tokens, (token) => env.sendWith(`Bearer ${token}`, ME));
    expect(replies.map((reply) => [reply.status, (reply.body as { id?: string }).id])).toEqual(
      tokens.map(() => [200, shared.id]),
    );
  });

  it('refuses a missing or malformed header, and a token that is expired, not yet valid, from another issuer, for another audience, signed by an unknown key, unsigned (alg none), HS256 signed with the public key, RS384 or PS256 signed with a key in the key set, with an unknown critical header, with a payload that is not a JSON object, or without exp or sub, all with the same 401', async () => {
    const { shared } = env.world.people;
    const subject = shared.subject;
    const claims = env.idp.claims(subject);
    const t = (options: Parameters<typeof env.idp.token>[1]) => env.idp.token(subject, options);
    const headers: [string, string | undefined][] = [
      ['missing', undefined],
      ['empty', ''],
      // Valid tokens under another scheme: only the scheme can refuse them.
      ['a valid token under the Basic scheme', `Basic ${await t({})}`],
      ['a valid token under the Token scheme', `Token ${await t({})}`],
      ['no token', 'Bearer '],
      ['one segment', 'Bearer abc'],
      ['segments that are not a JWT', 'Bearer abc.def.ghi'],
      ['two tokens', `Bearer ${await t({})} ${await t({})}`],
      ['expired a minute ago', `Bearer ${await t({ claims: { exp: now() - 60 } })}`],
      ['valid from a minute ahead', `Bearer ${await t({ claims: { nbf: now() + 60 } })}`],
      ['another issuer', `Bearer ${await t({ claims: { iss: 'https://other.example.test' } })}`],
      [
        "the key set's address as issuer",
        `Bearer ${await t({ claims: { iss: new URL(env.idp.jwksUrl).origin } })}`,
      ],
      ['another audience', `Bearer ${await t({ claims: { aud: 'rff-dashboard' } })}`],
      ['no audience', `Bearer ${await t({ claims: { aud: undefined } })}`],
      ['an unknown key', `Bearer ${await t({ key: 'outsider' })}`],
      [
        "an unknown key under a known key's kid",
        `Bearer ${await t({ key: 'outsider', kid: env.idp.rsaKid })}`,
      ],
      ['alg none', `Bearer ${unsignedToken(claims)}`],
      [
        'HS256 with the RSA public key as secret',
        `Bearer ${hmacToken(claims, env.idp.rsaPublicKeyPem, env.idp.rsaKid)}`,
      ],
      // The key set lists this key without "alg", so only the API's list refuses these.
      ['RS384 by a key in the key set', `Bearer ${await t({ key: 'unpinned', alg: 'RS384' })}`],
      ['PS256 by a key in the key set', `Bearer ${await t({ key: 'unpinned', alg: 'PS256' })}`],
      [
        'an unknown critical header',
        `Bearer ${await env.idp.rawToken({ crit: ['x-unknown'], 'x-unknown': 1 }, claims)}`,
      ],
      ['a payload that is a JSON array', `Bearer ${await env.idp.rawToken({}, [claims])}`],
      ['no exp', `Bearer ${await t({ claims: { exp: undefined } })}`],
      ['no sub', `Bearer ${await t({ claims: { sub: undefined } })}`],
      ['an empty sub', `Bearer ${await t({ claims: { sub: '' } })}`],
    ];
    const replies = await inSequence(headers, ([, header]) => env.sendWith(header, ME));
    const refusal = replies[0];
    expect(refusal?.status).toBe(401);
    expect(refusal?.body).toEqual({ message: 'Unauthorized', statusCode: 401 });
    expect(refusal?.headers['www-authenticate']).toBe('Bearer');
    expect(replies.map((reply, index) => `${headers[index]?.[0]}: ${comparable(reply)}`)).toEqual(
      headers.map(([label]) => `${label}: ${comparable(refusal!)}`),
    );
    // The same token with the defaults is accepted, also when signed outside SignJWT,
    // so each refusal comes from the one claim or header that differs.
    const accepted = [`Bearer ${await t({})}`, `Bearer ${await env.idp.rawToken({}, claims)}`];
    const statuses = await inSequence(accepted, (header) => env.sendWith(header, ME));
    expect(statuses.map((reply) => reply.status)).toEqual([200, 200]);
  });

  it('refuses a valid token for an issuer and subject pair that is not in users, as it refuses an invalid token', async () => {
    const { canaryEditorOfA, shared } = env.world.people;
    const unknown = await env.sendWith(
      `Bearer ${await env.idp.token(`nobody-${randomUUID()}`)}`,
      ME,
    );
    // This user exists, but at another issuer, so the configured issuer does not find it.
    const otherIssuer = await env.sendWith(
      `Bearer ${await env.idp.token(canaryEditorOfA.subject)}`,
      ME,
    );
    const invalid = await env.sendWith('Bearer abc.def.ghi', ME);
    expect(unknown.status).toBe(401);
    expect(comparable(unknown)).toBe(comparable(invalid));
    expect(comparable(otherIssuer)).toBe(comparable(invalid));
    expect((await env.send(shared, ME)).status).toBe(200);
  });

  it('answers 503 when the key set cannot be fetched, and lets no request through', async () => {
    const idp = await startIdp(env.idp.issuer);
    idp.setAvailable(false);
    // A new app, so no key set is cached from earlier requests.
    const api = await startApi(apiConfig(env.database.appUrl, idp));
    try {
      const token = await idp.token(env.world.people.shared.subject);
      const reply = await request(api.base, ME, `Bearer ${token}`);
      expect(reply.status).toBe(503);
      expect(idp.fetches).toBeGreaterThan(0);
      idp.setAvailable(true);
      expect((await request(api.base, ME, `Bearer ${token}`)).status).toBe(200);
    } finally {
      await api.close();
      await idp.close();
    }
  });
});

describe('route access', () => {
  it('start-up fails when a route handler declares no access, and names it', async () => {
    @Controller('tenants/:tenantId')
    class UndeclaredController {
      @Get('flags-without-access')
      list(): string {
        return 'reachable';
      }

      @Get('declared')
      @Access('viewer')
      declared(): string {
        return 'declared';
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(apiConfig(env.database.appUrl, env.idp))],
      controllers: [UndeclaredController],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ logger: false });
    try {
      const started = app.init().then(
        () => undefined,
        (error: unknown) => error,
      );
      const error = await started;
      expect(error).toBeInstanceOf(UndeclaredAccessError);
      expect((error as UndeclaredAccessError).handlers).toEqual(['UndeclaredController.list']);
    } finally {
      await app.close();
    }
    // The app itself starts, so every one of its routes declares its access.
    expect(env.api.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('membership is read on every request: removing a member, adding one back and changing the role apply to the next request', async () => {
    const { viewerOfA } = env.world.people;
    const { tenantA } = env.world.fixture;
    await env.world.seed(env.admin);
    const read: Call = { method: 'GET', path: `/tenants/${tenantA}/flags` };
    const write: Call = {
      method: 'POST',
      path: `/tenants/${tenantA}/flags`,
      body: { key: 'role-change', enabled: false, rules: [], rolloutBasisPoints: 0 },
    };
    const statuses: number[] = [];
    statuses.push(
      (await env.send(viewerOfA, read)).status,
      (await env.send(viewerOfA, write)).status,
    );
    await env.admin.query('DELETE FROM public.memberships WHERE tenant_id = $1 AND user_id = $2', [
      tenantA,
      viewerOfA.id,
    ]);
    statuses.push((await env.send(viewerOfA, read)).status);
    await env.admin.query(
      "INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'editor')",
      [tenantA, viewerOfA.id],
    );
    statuses.push((await env.send(viewerOfA, write)).status);
    await env.admin.query(
      "UPDATE public.memberships SET role = 'viewer' WHERE tenant_id = $1 AND user_id = $2",
      [tenantA, viewerOfA.id],
    );
    statuses.push((await env.send(viewerOfA, write)).status);
    expect(statuses).toEqual([200, 403, 404, 201, 403]);
  });

  it('a user in no tenant, a member of another tenant, a tenant that does not exist and a path tenant that is not a UUID all get the same 404', async () => {
    const { outsider, editorOfB, shared } = env.world.people;
    const { tenantA } = env.world.fixture;
    const replies = [
      await env.send(outsider, flags(tenantA)),
      await env.send(editorOfB, flags(tenantA)),
      await env.send(shared, flags(randomUUID())),
      await env.send(shared, flags('not-a-uuid')),
      await env.send(shared, flags(`${tenantA}x`)),
    ];
    expect(replies[0]?.status).toBe(404);
    expect(replies[0]?.body).toEqual({ message: 'Not Found', statusCode: 404 });
    expect(new Set(replies.map(comparable)).size).toBe(1);
    // The path's tenant id is matched in any letter case.
    expect((await env.send(shared, flags(tenantA.toUpperCase()))).status).toBe(200);
  });

  it("a role in one tenant gives no rights in another: the shared user, owner in A and viewer in B, may change A's flags and keys and may only read B's", async () => {
    const { shared } = env.world.people;
    const { tenantA, tenantB } = env.world.fixture;
    await env.world.seed(env.admin);
    const statuses = async (tenant: string): Promise<number[]> =>
      (await inSequence(ownerCalls(tenant), (call) => env.send(shared, call))).map((r) => r.status);
    expect(await statuses(tenantA)).toEqual([200, 200, 201]);
    expect(await statuses(tenantB)).toEqual([200, 403, 403]);
  });
});
