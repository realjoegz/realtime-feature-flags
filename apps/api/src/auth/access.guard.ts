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
import { setRequestAuth } from './request-auth.js';
import { KeySetUnavailableError, TokenVerifier } from './token-verifier.js';

// Runs before every route handler (registered as APP_GUARD). Membership is read from
// the database on every request, through the member_role_in_tenant look-up, and never
// from the token or a cache, so a role change applies to the next request.
//
//   no or invalid token, or a token for an unknown user   401
//   not a member of the path's tenant, or no such tenant   404, as for a missing resource
//   a member below the route's role                         403

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

  private async signedInUser(request: Request, response: Response): Promise<string> {
    const refuse = (): UnauthorizedException => {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return new UnauthorizedException();
    };
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match === null) throw refuse();
    let verified;
    try {
      verified = await this.tokens.verify(match[1] as string);
    } catch (error) {
      if (error instanceof KeySetUnavailableError) {
        this.logger.warn(error.message);
        throw new ServiceUnavailableException();
      }
      throw refuse();
    }
    const userId = await this.db.userIdForSubject(verified.issuer, verified.subject);
    if (userId === null) throw refuse();
    return userId;
  }
}
