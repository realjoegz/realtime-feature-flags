import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { TenantDatabase } from '../database/tenant-database.js';
import { notFound } from '../http/errors.js';
import { accessOf, ROLE_RANK } from './access.js';
import { setRequestAuth, setSdkAuth } from './request-auth.js';
import { KeySetUnavailableError, TokenVerifier } from './token-verifier.js';

// Runs before every route handler (registered as APP_GUARD). Membership is read from
// the database on every request, through the member_role_in_tenant look-up, and never
// from the token or a cache, so a role change applies to the next request.
//
//   no or invalid token, or a token for an unknown user   401
//   not a member of the path's tenant, or no such tenant   404, as for a missing resource
//   a member below the route's role                         403
//
// A route that requires an SDK key takes no user token: its tenant is the key's,
// found by the key's SHA-256 through tenant_id_for_sdk_key on every request, so a
// revoked key is refused from its next request on. A missing, malformed, unknown or
// revoked key, and a user token, all get the same 401.

/** The parts of Express's request and response that the guard uses. */
interface Request {
  readonly headers: { readonly authorization?: string | undefined };
  readonly params: Readonly<Record<string, string | string[] | undefined>>;
}
interface Response {
  setHeader(name: string, value: string): unknown;
}

// The scheme is case-insensitive (RFC 9110); the token is three base64url segments,
// the last one empty for an unsigned token, which the verifier then refuses.
const BEARER = /^bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)$/i;

// rff_sdk_ and 32 bytes in base64url without padding, as POST /sdk-keys issues them.
// The scheme is case-insensitive; the key is not.
const SDK_KEY = /^[Bb][Ee][Aa][Rr][Ee][Rr] (rff_sdk_[A-Za-z0-9_-]{43})$/;

@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger('Access');

  constructor(
    private readonly tokens: TokenVerifier,
    private readonly db: TenantDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level = accessOf(context.getHandler());
    // RouteAccessCheck stops start-up first; this keeps an undeclared route closed.
    if (level === undefined) throw new Error('the route declares no access');
    if (level === 'public') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (level === 'sdk-key') {
      const tenantId = await this.sdkKeyTenant(request, http.getResponse<Response>());
      setSdkAuth(request, { tenantId });
      return true;
    }
    const userId = await this.signedInUser(request, http.getResponse<Response>());
    if (level === 'signed-in') {
      setRequestAuth(request, { userId });
      return true;
    }

    const path = request.params['tenantId'];
    const tenantId = typeof path === 'string' ? path.toLowerCase() : undefined;
    const role = tenantId === undefined ? null : await this.db.memberRole(userId, tenantId);
    if (tenantId === undefined || role === null) throw notFound();
    if (ROLE_RANK[role] < ROLE_RANK[level]) throw new ForbiddenException();
    setRequestAuth(request, { userId, member: { tenantId, userId, role } });
    return true;
  }

  private async sdkKeyTenant(request: Request, response: Response): Promise<string> {
    const key = SDK_KEY.exec(request.headers.authorization ?? '')?.[1];
    const hash = key === undefined ? null : createHash('sha256').update(key).digest();
    const tenantId = hash === null ? null : await this.db.tenantIdForSdkKeyHash(hash);
    if (tenantId === null) throw refuse(response);
    return tenantId;
  }

  private async signedInUser(request: Request, response: Response): Promise<string> {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match === null) throw refuse(response);
    let verified;
    try {
      verified = await this.tokens.verify(match[1] as string);
    } catch (error) {
      if (error instanceof KeySetUnavailableError) {
        this.logger.warn(error.message);
        throw new ServiceUnavailableException();
      }
      throw refuse(response);
    }
    const userId = await this.db.userIdForSubject(verified.issuer, verified.subject);
    if (userId === null) throw refuse(response);
    return userId;
  }
}

/** 401 with the challenge that tells the client to send a bearer token. */
function refuse(response: Response): UnauthorizedException {
  response.setHeader('WWW-Authenticate', 'Bearer');
  return new UnauthorizedException();
}
