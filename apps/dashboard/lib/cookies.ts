import { hkdfSync } from 'node:crypto';
import { EncryptJWT, jwtDecrypt, type JWTPayload } from 'jose';

// The dashboard's two cookies, each an encrypted JWT (JWE, dir with A256GCM) that only
// the server can read or forge:
//
// - rff_session: the signed-in user's access token for the API and the few claims the
//   pages show. It expires when the access token does.
// - rff_auth_flow: the state, nonce and PKCE code verifier of a sign-in that has
//   started, for the callback to check. It lives for 10 minutes and is sent only to
//   /auth/callback.
//
// Both are httpOnly and SameSite=Lax. Each has its own key, derived from the session
// secret with HKDF, so neither can stand in for the other.

export const SESSION_COOKIE = 'rff_session';
export const FLOW_COOKIE = 'rff_auth_flow';
export const FLOW_PATH = '/auth/callback';
export const FLOW_LIFETIME_SECONDS = 600;

export interface Session {
  /** The access token the API accepts as bearer. Never sent to the browser in clear. */
  readonly accessToken: string;
  /** The identity provider's "sub" for the user. */
  readonly subject: string;
  readonly name: string;
  readonly email: string;
  /** When the access token expires, in seconds since the epoch. */
  readonly expiresAt: number;
}

export interface Flow {
  readonly state: string;
  readonly nonce: string;
  /** The PKCE code verifier whose S256 challenge went in the authorization request. */
  readonly verifier: string;
}

export interface CookieSettings {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly path: string;
  readonly secure: boolean;
  /** Seconds. 0 deletes the cookie. */
  readonly maxAge: number;
}

type Purpose = 'session' | 'flow';

const TYP: Record<Purpose, string> = { session: 'rff-session', flow: 'rff-auth-flow' };

function keyFor(secret: string, purpose: Purpose): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, '', `rff-dashboard ${purpose} cookie`, 32));
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function seal(
  purpose: Purpose,
  claims: JWTPayload,
  expiresAt: number,
  secret: string,
  now: Date,
): Promise<string> {
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: TYP[purpose] })
    .setIssuedAt(seconds(now))
    .setExpirationTime(expiresAt)
    .encrypt(keyFor(secret, purpose));
}

/** The payload, or null for a value that is missing, altered, of the other kind or expired. */
async function open(
  purpose: Purpose,
  value: string | undefined,
  secret: string,
  now: Date,
): Promise<JWTPayload | null> {
  if (value === undefined || value === '') return null;
  try {
    const { payload } = await jwtDecrypt(value, keyFor(secret, purpose), {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
      typ: TYP[purpose],
      requiredClaims: ['exp'],
      currentDate: now,
    });
    return payload;
  } catch {
    return null;
  }
}

function text(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function sealSession(session: Session, secret: string, now = new Date()): Promise<string> {
  return seal(
    'session',
    { at: session.accessToken, sub: session.subject, name: session.name, email: session.email },
    session.expiresAt,
    secret,
    now,
  );
}

export async function openSession(
  value: string | undefined,
  secret: string,
  now = new Date(),
): Promise<Session | null> {
  const payload = await open('session', value, secret, now);
  if (payload === null) return null;
  const accessToken = text(payload, 'at');
  const subject = text(payload, 'sub');
  if (accessToken === null || subject === null || typeof payload.exp !== 'number') return null;
  return {
    accessToken,
    subject,
    name: text(payload, 'name') ?? '',
    email: text(payload, 'email') ?? '',
    expiresAt: payload.exp,
  };
}

export function sealFlow(flow: Flow, secret: string, now = new Date()): Promise<string> {
  return seal(
    'flow',
    { state: flow.state, nonce: flow.nonce, verifier: flow.verifier },
    seconds(now) + FLOW_LIFETIME_SECONDS,
    secret,
    now,
  );
}

export async function openFlow(
  value: string | undefined,
  secret: string,
  now = new Date(),
): Promise<Flow | null> {
  const payload = await open('flow', value, secret, now);
  if (payload === null) return null;
  const state = text(payload, 'state');
  const nonce = text(payload, 'nonce');
  const verifier = text(payload, 'verifier');
  if (state === null || nonce === null || verifier === null) return null;
  return { state, nonce, verifier };
}

/** The session cookie, living until the access token expires. */
export function sessionCookie(
  value: string,
  session: Session,
  secure: boolean,
  now = new Date(),
): CookieSettings {
  const maxAge = Math.max(0, session.expiresAt - seconds(now));
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge,
  };
}

export function flowCookie(value: string, secure: boolean): CookieSettings {
  return {
    name: FLOW_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    path: FLOW_PATH,
    secure,
    maxAge: FLOW_LIFETIME_SECONDS,
  };
}

/** A cookie setting that deletes the cookie named name at path. */
export function deletedCookie(name: string, path: string, secure: boolean): CookieSettings {
  return { name, value: '', httpOnly: true, sameSite: 'lax', path, secure, maxAge: 0 };
}
