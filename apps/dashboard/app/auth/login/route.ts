import { NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import { flowCookie, sealFlow } from '../../../lib/cookies';
import { startSignIn } from '../../../lib/oidc';

// GET /auth/login starts a sign-in: it keeps a new state, nonce and PKCE code
// verifier in the encrypted flow cookie and sends the browser to the identity
// provider's authorization endpoint.
export async function GET(): Promise<Response> {
  const config = loadConfig();
  let started: Awaited<ReturnType<typeof startSignIn>>;
  try {
    started = await startSignIn(config);
  } catch (error) {
    console.warn(
      `sign-in: discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Response('The identity provider cannot be reached. Try again shortly.\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const response = NextResponse.redirect(started.url, 303);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(
    flowCookie(await sealFlow(started.flow, config.sessionSecret), config.secureCookies),
  );
  return response;
}
