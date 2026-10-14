import { describe, expect, it } from 'vitest';
import {
  FLOW_LIFETIME_SECONDS,
  openFlow,
  openSession,
  sealFlow,
  sealSession,
  type Session,
  sessionCookie,
} from '../lib/cookies';
import { SESSION_SECRET } from './support/env';
import { expectSealed } from './support/sealed';

// The session cookie (lib/cookies.ts): an encrypted JWT holding the access token,
// which only the dashboard's server can read or forge.

const NOW = new Date('2026-10-14T12:00:00Z');
const nowSeconds = NOW.getTime() / 1000;

const session: Session = {
  accessToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl',
  subject: 'user-1',
  name: 'User One',
  email: 'user-1@example.test',
  expiresAt: nowSeconds + 3600,
};

/** The moment seconds after NOW. */
function at(seconds: number): Date {
  return new Date((nowSeconds + seconds) * 1000);
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * value with the character at index replaced. The replacement differs in the
 * highest of the six bits, which every base64url character, the last of a segment
 * included, contributes to the decoded bytes.
 */
function changedAt(value: string, index: number): string {
  const position = BASE64URL.indexOf(value[index] ?? '');
  return `${value.slice(0, index)}${BASE64URL[position ^ 0b100000]}${value.slice(index + 1)}`;
}

describe('session cookie', () => {
  it('a sealed session opens to the same session, it and a sealed sign-in flow are encrypted JWTs whose decoded segments show nothing they hold, and its cookie is httpOnly, SameSite=Lax, path / and expires with the access token', async () => {
    const value = await sealSession(session, SESSION_SECRET, NOW);
    expect(await openSession(value, SESSION_SECRET, NOW)).toEqual(session);
    // Encrypted: neither the token, nor a part of it, nor a claim shows in the value or
    // in any of its segments decoded.
    const [, tokenPayload = '', tokenSignature = ''] = session.accessToken.split('.');
    expectSealed(value, 'rff-session', [
      session.accessToken,
      tokenPayload,
      tokenSignature,
      session.email,
      session.subject,
      session.name,
    ]);
    const flow = { state: 'state-S1', nonce: 'nonce-N1', verifier: 'verifier-V1' };
    expectSealed(await sealFlow(flow, SESSION_SECRET, NOW), 'rff-auth-flow', Object.values(flow));
    expect(sessionCookie(value, session, false, NOW)).toEqual({
      name: 'rff_session',
      value,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      maxAge: 3600,
    });
    expect(sessionCookie(value, session, true, NOW).secure).toBe(true);
  });

  it('a session cookie with any one character changed, sealed with another secret, or sealed as a sign-in flow does not open', async () => {
    const value = await sealSession(session, SESSION_SECRET, NOW);
    let changed = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '.') continue;
      // eslint-disable-next-line no-await-in-loop -- one decryption at a time
      expect(await openSession(changedAt(value, index), SESSION_SECRET, NOW)).toBeNull();
      changed += 1;
    }
    expect(changed).toBeGreaterThan(200);
    // Dropping the last character, or the authentication tag, does not open either.
    expect(await openSession(value.slice(0, -1), SESSION_SECRET, NOW)).toBeNull();
    expect(
      await openSession(value.slice(0, value.lastIndexOf('.') + 1), SESSION_SECRET, NOW),
    ).toBeNull();

    const otherSecret = await sealSession(session, `${SESSION_SECRET}-other`, NOW);
    expect(await openSession(otherSecret, SESSION_SECRET, NOW)).toBeNull();

    // A flow cookie made with the same secret carries the same kind of payload.
    const flow = await sealFlow({ state: 's', nonce: 'n', verifier: 'v' }, SESSION_SECRET, NOW);
    expect(await openSession(flow, SESSION_SECRET, NOW)).toBeNull();
    expect(await openFlow(value, SESSION_SECRET, NOW)).toBeNull();
    expect(await openFlow(flow, SESSION_SECRET, NOW)).toEqual({
      state: 's',
      nonce: 'n',
      verifier: 'v',
    });
  });

  it('a session does not open once its access token has expired, and a sign-in flow not after 10 minutes', async () => {
    const value = await sealSession(session, SESSION_SECRET, NOW);
    expect(await openSession(value, SESSION_SECRET, at(3599))).toEqual(session);
    expect(await openSession(value, SESSION_SECRET, at(3600))).toBeNull();
    expect(await openSession(value, SESSION_SECRET, at(86_400))).toBeNull();
    expect(sessionCookie(value, session, false, at(3600)).maxAge).toBe(0);

    const flow = await sealFlow({ state: 's', nonce: 'n', verifier: 'v' }, SESSION_SECRET, NOW);
    expect(await openFlow(flow, SESSION_SECRET, at(FLOW_LIFETIME_SECONDS - 1))).not.toBeNull();
    expect(await openFlow(flow, SESSION_SECRET, at(FLOW_LIFETIME_SECONDS))).toBeNull();
  });
});
