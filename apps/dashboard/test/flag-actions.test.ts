import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../lib/api';
import { sealSession } from '../lib/cookies';
import { saveFlag } from '../lib/flag-actions';
import { SESSION_SECRET, useDashboardEnv } from './support/env';
import { type FakeApi, startFakeApi } from './support/fake-api';

// The flag form's server action (lib/flag-actions.ts), called as Next.js calls it,
// with the request's cookies from next/headers, against a server that records the
// requests the API would get. refresh() from next/cache only works inside Next.js, so
// both modules are replaced: cookies() returns the session cookie set below.

const request = vi.hoisted(() => ({ sessionCookie: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'rff_session' && request.sessionCookie !== undefined
        ? { name, value: request.sessionCookie }
        : undefined,
  }),
}));

const refresh = vi.hoisted(() => vi.fn<() => void>());
vi.mock('next/cache', () => ({ refresh }));

const ACME = 'ac3e0000-0000-4000-8000-000000000001';
const GLOBEX = '610be000-0000-4000-8000-000000000002';
const NOWHERE = '00000000-0000-4000-8000-000000000000';

/** Each token's user: a viewer of acme and editor of globex, or an editor of acme. */
const USERS: Record<string, Me> = {
  'token-of-viewer': {
    id: 'u-viewer',
    email: 'viewer@example.test',
    name: 'Viewer',
    memberships: [
      { tenantId: ACME, slug: 'acme', name: 'Acme', role: 'viewer' },
      { tenantId: GLOBEX, slug: 'globex', name: 'Globex', role: 'editor' },
    ],
  },
  'token-of-editor': {
    id: 'u-editor',
    email: 'editor@example.test',
    name: 'Editor',
    memberships: [{ tenantId: ACME, slug: 'acme', name: 'Acme', role: 'editor' }],
  },
};

const RULES = [{ attribute: 'plan', operator: 'equals', values: ['beta'], serve: true }];

let fake: FakeApi;

beforeAll(async () => {
  fake = await startFakeApi((recorded) => {
    const token = recorded.authorization?.replace(/^Bearer /, '') ?? '';
    if (recorded.path === '/me') return { status: 200, body: USERS[token] };
    if (recorded.method === 'GET' && recorded.path === `/tenants/${ACME}/flags/new-checkout`) {
      return {
        status: 200,
        body: {
          key: 'new-checkout',
          enabled: false,
          salt: '3f1a9c0d7e2b4a65',
          rules: RULES,
          rolloutBasisPoints: 0,
        },
      };
    }
    if (recorded.method === 'PUT') return { status: 200, body: { version: 8, flag: {} } };
    return { status: 404, body: { message: 'Not Found', statusCode: 404 } };
  });
  useDashboardEnv({ apiUrl: fake.url });
});

afterAll(async () => {
  await fake?.close();
});

beforeEach(() => {
  fake.requests.length = 0;
  refresh.mockClear();
});

async function signInAs(token: string): Promise<void> {
  request.sessionCookie = await sealSession(
    {
      accessToken: token,
      subject: token,
      name: '',
      email: '',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
    SESSION_SECRET,
  );
}

function form(tenantId: string, fields: { enabled?: boolean; percent?: string } = {}): FormData {
  const data = new FormData();
  data.set('tenantId', tenantId);
  data.set('flagKey', 'new-checkout');
  if (fields.enabled ?? true) data.set('enabled', 'on');
  data.set('percent', fields.percent ?? '25.5');
  return data;
}

describe('flag server action', () => {
  it('saveFlag refuses a viewer, and a tenant the user is not in with the answer for a tenant that does not exist, and sends no flag request', async () => {
    await signInAs('token-of-viewer');
    expect(await saveFlag(null, form(ACME))).toEqual({
      ok: false,
      message: 'Viewers cannot change flags.',
    });

    await signInAs('token-of-editor');
    const outside = await saveFlag(null, form(GLOBEX));
    expect(outside).toEqual({ ok: false, message: 'Not found.' });
    expect(await saveFlag(null, form(NOWHERE))).toEqual(outside);

    // Each call read only GET /me, as the user who made it, and nothing was refreshed.
    expect(fake.requests.map((r) => `${r.method} ${r.path} ${r.authorization}`)).toEqual([
      'GET /me Bearer token-of-viewer',
      'GET /me Bearer token-of-editor',
      'GET /me Bearer token-of-editor',
    ]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("saveFlag as an editor sends the new enabled and rollout with the flag's rules unchanged, as the signed-in user, and renders the page again", async () => {
    await signInAs('token-of-editor');
    expect(await saveFlag(null, form(ACME, { enabled: true, percent: '25.5' }))).toEqual({
      ok: true,
      message: 'Saved as version 8.',
    });
    expect(fake.requests).toEqual([
      { method: 'GET', path: '/me', authorization: 'Bearer token-of-editor', body: undefined },
      {
        method: 'GET',
        path: `/tenants/${ACME}/flags/new-checkout`,
        authorization: 'Bearer token-of-editor',
        body: undefined,
      },
      {
        method: 'PUT',
        path: `/tenants/${ACME}/flags/new-checkout`,
        authorization: 'Bearer token-of-editor',
        body: { enabled: true, rules: RULES, rolloutBasisPoints: 2550 },
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
