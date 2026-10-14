import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as api from '../lib/api';
import type { Session } from '../lib/cookies';
import { useDashboardEnv } from './support/env';
import { type FakeApi, startFakeApi } from './support/fake-api';

// The dashboard's API client (lib/api.ts) against a server that records requests.

let fake: FakeApi;

beforeAll(async () => {
  fake = await startFakeApi(() => ({ status: 200, body: {} }));
  useDashboardEnv({ apiUrl: fake.url });
});

afterAll(async () => {
  await fake?.close();
});

const TENANT = 'ac3e0000-0000-4000-8000-000000000001';

const sessionOf = (accessToken: string): Session => ({
  accessToken,
  subject: `subject-of-${accessToken}`,
  name: '',
  email: '',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});

/** One call of each request function of the client, by its exported name. */
const CALLS: Record<string, (session: Session) => Promise<unknown>> = {
  getMe: (session) => api.getMe(session),
  listFlags: (session) => api.listFlags(session, TENANT),
  getFlag: (session) => api.getFlag(session, TENANT, 'dark-mode'),
  updateFlag: (session) =>
    api.updateFlag(session, TENANT, 'dark-mode', {
      enabled: true,
      rules: [],
      rolloutBasisPoints: 1,
    }),
  listAudit: (session) => api.listAudit(session, TENANT),
  listMembers: (session) => api.listMembers(session, TENANT),
};

describe('API client', () => {
  it("every request function sends its own session's token", async () => {
    // A function added to the client without a call here fails this test.
    const functions = Object.entries(api)
      .filter(([, value]) => typeof value === 'function' && value !== api.ApiError)
      .map(([name]) => name);
    expect(functions.toSorted()).toEqual(Object.keys(CALLS).toSorted());

    const first = sessionOf('token-of-first.user');
    const second = sessionOf('token-of-second.user');
    for (const [name, call] of Object.entries(CALLS)) {
      fake.requests.length = 0;
      // Both sessions at once, so a token kept between calls would show.
      // eslint-disable-next-line no-await-in-loop -- one function at a time
      await Promise.all([call(first), call(second), call(first)]);
      expect(fake.requests.map((request) => request.authorization).toSorted(), name).toEqual([
        'Bearer token-of-first.user',
        'Bearer token-of-first.user',
        'Bearer token-of-second.user',
      ]);
      const paths = new Set(fake.requests.map((request) => `${request.method} ${request.path}`));
      expect(paths.size, name).toBe(1);
    }
    expect(fake.requests.length).toBe(3);
  });
});
