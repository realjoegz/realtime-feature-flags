import { loadConfig } from './config';
import type { Session } from './cookies';

// The API as the dashboard's server calls it: every request carries the signed-in
// user's access token as bearer, so the API checks that user's role in the tenant on
// each call. The browser never calls the API and never holds the token.

export type Role = 'viewer' | 'editor' | 'owner';

export interface Membership {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: Role;
}

export interface Me {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly memberships: readonly Membership[];
}

export interface Rule {
  readonly attribute: string;
  readonly operator: 'equals' | 'in';
  readonly values: readonly string[];
  readonly serve: boolean;
}

export interface Flag {
  readonly key: string;
  readonly enabled: boolean;
  readonly salt: string;
  readonly rules: readonly Rule[];
  readonly rolloutBasisPoints: number;
}

export interface FlagSettings {
  readonly enabled: boolean;
  readonly rules: readonly Rule[];
  readonly rolloutBasisPoints: number;
}

export interface AuditEntry {
  readonly id: number;
  readonly actorUserId: string;
  readonly action: string;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly version: number | null;
  readonly at: string;
}

export interface Member {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly role: Role;
}

/** A reply that is not 2xx. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`the API answered ${status}`);
    this.name = 'ApiError';
  }
}

async function call<T>(
  session: Session,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${session.accessToken}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${loadConfig().apiUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed as T;
}

const tenantPath = (tenantId: string): string => `/tenants/${encodeURIComponent(tenantId)}`;

export function getMe(session: Session): Promise<Me> {
  return call(session, 'GET', '/me');
}

export function listFlags(
  session: Session,
  tenantId: string,
): Promise<{ version: number; flags: Flag[] }> {
  return call(session, 'GET', `${tenantPath(tenantId)}/flags`);
}

export function getFlag(session: Session, tenantId: string, key: string): Promise<Flag> {
  return call(session, 'GET', `${tenantPath(tenantId)}/flags/${encodeURIComponent(key)}`);
}

export function updateFlag(
  session: Session,
  tenantId: string,
  key: string,
  settings: FlagSettings,
): Promise<{ version: number; flag: Flag }> {
  return call(session, 'PUT', `${tenantPath(tenantId)}/flags/${encodeURIComponent(key)}`, settings);
}

export function listAudit(session: Session, tenantId: string): Promise<{ entries: AuditEntry[] }> {
  return call(session, 'GET', `${tenantPath(tenantId)}/audit`);
}

export function listMembers(session: Session, tenantId: string): Promise<{ members: Member[] }> {
  return call(session, 'GET', `${tenantPath(tenantId)}/members`);
}
