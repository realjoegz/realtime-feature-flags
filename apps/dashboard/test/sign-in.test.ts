import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as callback } from '../app/auth/callback/route';
import { GET as login } from '../app/auth/login/route';
import { FLOW_COOKIE, openFlow, openSession, sealFlow, SESSION_COOKIE } from '../lib/cookies';
import { REDIRECT_URI, SESSION_SECRET, useDashboardEnv } from './support/env';
import { type Provider, startProvider } from './support/provider';
import { expectSealed } from './support/sealed';

// The sign-in routes against a local OpenID provider (support/provider.ts), whose
// token endpoint checks the PKCE code verifier as Dex does. Each test starts a
// sign-in with GET /auth/login, plays the browser at the provider, and calls
// GET /auth/callback with the flow cookie the login route set.

let provider: Provider;

beforeAll(async () => {
  provider = await startProvider();
  useDashboardEnv({ issuer: provider.issuer, clientSecret: provider.clientSecret });
});

afterAll(async () => {
  await provider?.close();
});

interface SetCookie {
  readonly value: string;
  /** Attribute names in lower case, with their values ('' for flags such as HttpOnly). */
  readonly attributes: Readonly<Record<string, string>>;
}

function setCookies(response: Response): Map<string, SetCookie> {
  const cookies = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...rest] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const attributes: Record<string, string> = {};
    for (const attribute of rest) {
      const [name = '', value = ''] = attribute.split('=');
      attributes[name.toLowerCase()] = value;
    }
    cookies.set(pair.slice(0, separator), {
      value: decodeURIComponent(pair.slice(separator + 1)),
      attributes,
    });
  }
  return cookies;
}

/** GET /auth/login: where it sends the browser, and the flow cookie it set. */
async function startSignIn(): Promise<{ authorizationUrl: string; flow: SetCookie }> {
  const response = await login();
  expect(response.status).toBe(303);
  const flow = setCookies(response).get(FLOW_COOKIE);
  if (flow === undefined) throw new Error('the login route set no flow cookie');
  return { authorizationUrl: response.headers.get('location') ?? '', flow };
}

function callbackRequest(url: URL | string, flowValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (flowValue !== undefined)
    headers['cookie'] = `${FLOW_COOKIE}=${encodeURIComponent(flowValue)}`;
  return new NextRequest(url, { headers });
}

/** Asserts a refusal: 400 with the reason, no session cookie, and the flow cookie deleted. */
async function expectRefused(response: Response, reason: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(`Sign-in failed (${reason})`);
  const cookies = setCookies(response);
  expect(cookies.has(SESSION_COOKIE)).toBe(false);
  expect(cookies.get(FLOW_COOKIE)?.attributes['max-age']).toBe('0');
}

describe('sign-in', () => {
  it('the login route sends the browser to the provider with an S256 code challenge and keeps state, nonce and verifier in an encrypted httpOnly cookie; the callback sets an httpOnly SameSite=Lax session cookie holding the access token, which no header or body shows', async () => {
    const { authorizationUrl, flow } = await startSignIn();
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${provider.issuer}/auth`);
    const params = url.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('rff-dashboard');
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(params.get('scope')).toBe('openid email profile audience:server:client_id:rff-api');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(flow.attributes).toMatchObject({
      httponly: '',
      samesite: 'lax',
      path: '/auth/callback',
      'max-age': '600',
    });
    const opened = await openFlow(flow.value, SESSION_SECRET);
    expect(opened).toMatchObject({ state: params.get('state'), nonce: params.get('nonce') });
    expectSealed(flow.value, 'rff-auth-flow', [
      opened?.state ?? '',
      opened?.nonce ?? '',
      opened?.verifier ?? '',
    ]);

    const before = provider.tokenRequests;
    const response = await callback(
      callbackRequest(provider.authorize(authorizationUrl), flow.value),
    );
    expect(provider.tokenRequests).toBe(before + 1);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3100/');
    const cookies = setCookies(response);
    const session = cookies.get(SESSION_COOKIE);
    expect(session?.attributes).toMatchObject({ httponly: '', samesite: 'lax', path: '/' });
    expect(Number(session?.attributes['max-age'])).toBeGreaterThan(290);
    expect(Number(session?.attributes['max-age'])).toBeLessThanOrEqual(300);
    expect(cookies.get(FLOW_COOKIE)?.attributes['max-age']).toBe('0');

    const accessToken = provider.accessTokens.at(-1) ?? '';
    expect(await openSession(session?.value, SESSION_SECRET)).toMatchObject({
      accessToken,
      subject: 'user-1',
      name: 'User One',
      email: 'user-1@example.test',
    });
    expectSealed(session?.value ?? '', 'rff-session', [
      accessToken,
      accessToken.split('.')[1] ?? '',
      'user-1@example.test',
    ]);
    const headers = [...response.headers].filter(([name]) => name !== 'set-cookie');
    expect(JSON.stringify(headers)).not.toContain(accessToken.split('.')[1]);
    expect(await response.text()).not.toContain(accessToken.split('.')[1]);
  });

  it('the callback refuses a response whose state is wrong or missing, before the code reaches the provider', async () => {
    for (const state of ['wrong-state', null]) {
      // eslint-disable-next-line no-await-in-loop -- one sign-in at a time
      const { authorizationUrl, flow } = await startSignIn();
      const url = provider.authorize(authorizationUrl);
      if (state === null) url.searchParams.delete('state');
      else url.searchParams.set('state', state);
      const before = provider.tokenRequests;
      // eslint-disable-next-line no-await-in-loop -- one sign-in at a time
      await expectRefused(await callback(callbackRequest(url, flow.value)), 'state');
      expect(provider.tokenRequests).toBe(before);
    }
  });

  it('the callback refuses an ID token whose nonce is not the one the sign-in sent', async () => {
    const { authorizationUrl, flow } = await startSignIn();
    const url = provider.authorize(authorizationUrl, { nonce: 'another-nonce' });
    const before = provider.tokenRequests;
    await expectRefused(await callback(callbackRequest(url, flow.value)), 'nonce');
    // The code was exchanged; the ID token that came back was refused.
    expect(provider.tokenRequests).toBe(before + 1);
  });

  it('the callback refuses a sign-in without its code verifier: no flow cookie, or one that holds no verifier, and the code never reaches the provider', async () => {
    const { authorizationUrl, flow } = await startSignIn();
    const url = provider.authorize(authorizationUrl);
    const params = new URL(authorizationUrl).searchParams;
    const withoutVerifier = await sealFlow(
      { state: params.get('state') ?? '', nonce: params.get('nonce') ?? '', verifier: '' },
      SESSION_SECRET,
    );
    const before = provider.tokenRequests;
    await expectRefused(await callback(callbackRequest(url)), 'flow');
    await expectRefused(await callback(callbackRequest(url, withoutVerifier)), 'flow');
    expect(provider.tokenRequests).toBe(before);
    // The same callback with the flow cookie the sign-in set is accepted.
    expect((await callback(callbackRequest(url, flow.value))).status).toBe(303);
  });
});
