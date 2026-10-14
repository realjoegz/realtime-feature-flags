import { type NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import { deletedCookie, SESSION_COOKIE } from '../../../lib/cookies';

// POST /auth/logout deletes the session cookie and shows the signed-out page. The
// access token stays valid at the identity provider until it expires.
//
// SameSite=Lax keeps the session cookie off a POST from another site, but this route
// needs no cookie to delete it, so a form on any site could sign the user out. A
// browser sends Origin with every POST, so a request whose Origin is not the
// dashboard's own is refused with 403 and the cookie stays.
export function POST(request: NextRequest): Response {
  const config = loadConfig();
  if (request.headers.get('origin') !== config.oidc.redirectUri.origin) {
    return new Response('Sign-out refused: the request did not come from the dashboard.\n', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const response = NextResponse.redirect(new URL('/signed-out', config.oidc.redirectUri), 303);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(deletedCookie(SESSION_COOKIE, '/', config.secureCookies));
  return response;
}
