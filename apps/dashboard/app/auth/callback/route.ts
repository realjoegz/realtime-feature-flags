import { type NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '../../../lib/config';
import {
  deletedCookie,
  FLOW_COOKIE,
  FLOW_PATH,
  openFlow,
  sealSession,
  sessionCookie,
} from '../../../lib/cookies';
import { finishSignIn, SignInError, type SignInFailure } from '../../../lib/oidc';

const EXPLANATIONS: Record<SignInFailure, string> = {
  flow: 'this sign-in was not started here, or it took longer than 10 minutes',
  state: 'the response does not belong to the sign-in started here',
  nonce: 'the ID token does not belong to the sign-in started here',
  provider: 'the identity provider did not complete the sign-in',
};

/** The messages of an error and of its causes, for the log line. */
function causes(error: unknown): string {
  let text = '';
  for (let current = error; current instanceof Error; current = current.cause) {
    text += `: ${current.message}`;
  }
  return text;
}

// GET /auth/callback finishes a sign-in with what the flow cookie holds. On success
// the session cookie is set and the browser goes to the tenant list; on any failure
// the answer is 400 and no session cookie is set. Either way the flow cookie is
// deleted, so the browser cannot finish the same sign-in twice.
export async function GET(request: NextRequest): Promise<Response> {
  const config = loadConfig();
  const flow = await openFlow(request.cookies.get(FLOW_COOKIE)?.value, config.sessionSecret);
  // The registered redirect URI with the query the provider sent. openid-client sends
  // this URL, without its query, as redirect_uri; the request's own URL can name
  // another host, such as the container's address.
  const callbackUrl = new URL(config.oidc.redirectUri);
  callbackUrl.search = request.nextUrl.search;
  let response: NextResponse;
  try {
    const session = await finishSignIn(config, callbackUrl, flow);
    response = NextResponse.redirect(new URL('/', config.oidc.redirectUri), 303);
    response.cookies.set(
      sessionCookie(
        await sealSession(session, config.sessionSecret),
        session,
        config.secureCookies,
      ),
    );
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    console.warn(`sign-in refused (${error.reason})${causes(error.cause)}`);
    response = new NextResponse(
      `Sign-in failed (${error.reason}): ${EXPLANATIONS[error.reason]}. Start again at /auth/login.\n`,
      { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(deletedCookie(FLOW_COOKIE, FLOW_PATH, config.secureCookies));
  return response;
}
