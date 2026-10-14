import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MemberRole } from '../database/tenant-database.js';

// What AccessGuard established about a request, for the handler to use. The tenant
// a handler acts in comes from here, so it is always the one whose membership the
// guard checked.

/** A signed-in user acting in the tenant of the route path. */
export interface MemberScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

export interface RequestAuth {
  readonly userId: string;
  /** Set on routes under /tenants/:tenantId. */
  readonly member?: MemberScope;
}

const AUTH = Symbol('rff.auth');

interface WithAuth {
  [AUTH]?: RequestAuth;
}

export function setRequestAuth(request: object, auth: RequestAuth): void {
  (request as WithAuth)[AUTH] = auth;
}

function authOf(context: ExecutionContext): RequestAuth {
  const auth = context.switchToHttp().getRequest<WithAuth>()[AUTH];
  if (auth === undefined) throw new Error('the route reads the signed-in user but is public');
  return auth;
}

/** The signed-in user's id. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => authOf(context).userId,
);

/** The tenant of the path, the signed-in user and the user's role there. */
export const CurrentMember = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MemberScope => {
    const member = authOf(context).member;
    if (member === undefined) throw new Error('the route reads a tenant but declares no role');
    return member;
  },
);
