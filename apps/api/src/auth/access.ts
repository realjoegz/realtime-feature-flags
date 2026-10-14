import { SetMetadata } from '@nestjs/common';
import type { MemberRole } from '../database/tenant-database.js';

// Every route handler declares who may call it with @Access. RouteAccessCheck stops
// start-up when a handler has no declaration, and AccessGuard refuses a request to
// one, so a route cannot be added without deciding its access.
//
//   'public'     anyone, without a token (GET /health)
//   'signed-in'  any user with a valid token who is in the users table (GET /me)
//   a role       a member of the tenant in the path with at least that role

export type AccessLevel = 'public' | 'signed-in' | MemberRole;

export const ACCESS_METADATA = 'rff:access';

export const ROLE_RANK: Readonly<Record<MemberRole, number>> = { viewer: 1, editor: 2, owner: 3 };

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value);
}

/** Declares the access a route handler requires. */
export const Access = (level: AccessLevel): MethodDecorator => SetMetadata(ACCESS_METADATA, level);

/** The level a handler declared, or undefined when it declared none. */
export function accessOf(handler: object): AccessLevel | undefined {
  const level: unknown = Reflect.getMetadata(ACCESS_METADATA, handler);
  return level === 'public' || level === 'signed-in' || isMemberRole(level) ? level : undefined;
}
