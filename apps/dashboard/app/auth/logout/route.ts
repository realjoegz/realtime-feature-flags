import { NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import { deletedCookie, SESSION_COOKIE } from '../../../lib/cookies';

// POST /auth/logout deletes the session cookie and shows the signed-out page. The
// access token stays valid at the identity provider until it expires.
export function POST(): Response {
  const config = loadConfig();
  const response = NextResponse.redirect(new URL('/signed-out', config.oidc.redirectUri), 303);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(deletedCookie(SESSION_COOKIE, '/', config.secureCookies));
  return response;
}
