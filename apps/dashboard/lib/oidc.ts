import * as client from 'openid-client';
import type { DashboardConfig, OidcConfig } from './config';
import type { Flow, Session } from './cookies';

// Sign-in with the authorization code flow and PKCE (S256), through openid-client.
// The login route starts it and keeps the state, nonce and code verifier in the
// encrypted flow cookie; the callback route finishes it with them. openid-client
// checks the state before it uses the code, and the ID token's issuer, audience and
// nonce after the exchange; the code verifier goes to the token endpoint, which
// checks it against the challenge.

/** Why a callback was refused. The callback answers with it, and logs nothing else. */
export type SignInFailure =
  | 'flow' // no flow cookie, or one that is altered, expired or incomplete
  | 'state' // the response's state is missing or is not the flow's
  | 'nonce' // the ID token's nonce is not the flow's
  | 'provider'; // anything else: the provider refused the code, answered badly or was unreachable

export class SignInError extends Error {
  constructor(
    readonly reason: SignInFailure,
    options?: { cause?: unknown },
  ) {
    super(`sign-in failed: ${reason}`, options);
    this.name = 'SignInError';
  }
}

let discovered: {
  readonly key: string;
  readonly configuration: Promise<client.Configuration>;
} | null = null;

/**
 * The provider's metadata, discovered once and kept while the settings stay the same.
 * Discovery runs on the issuer as tokens name it, so openid-client's check that the
 * metadata's issuer equals it passes; the fetch below sends every request for that
 * origin to internalOrigin instead.
 */
export function oidcConfiguration(oidc: OidcConfig): Promise<client.Configuration> {
  const key = JSON.stringify([oidc.issuer.href, oidc.internalOrigin?.href, oidc.clientId]);
  if (discovered?.key !== key) {
    const configuration = discover(oidc);
    // A failed discovery is tried again on the next sign-in.
    configuration.catch(() => {
      if (discovered?.configuration === configuration) discovered = null;
    });
    discovered = { key, configuration };
  }
  return discovered.configuration;
}

function discover(oidc: OidcConfig): Promise<client.Configuration> {
  const { issuer, internalOrigin } = oidc;
  const reroute = (input: string): URL => {
    const url = new URL(input);
    if (internalOrigin !== null && url.origin === issuer.origin) {
      url.protocol = internalOrigin.protocol;
      url.host = internalOrigin.host;
    }
    return url;
  };
  const options: client.DiscoveryRequestOptions = {
    // init is what openid-client would pass to fetch itself; its body type names
    // Uint8Array<ArrayBufferLike>, which TypeScript's BodyInit does not.
    [client.customFetch]: (url, init) => fetch(reroute(url), init as RequestInit),
    timeout: 10,
  };
  return client.discovery(
    issuer,
    oidc.clientId,
    undefined,
    client.ClientSecretBasic(oidc.clientSecret),
    // openid-client refuses plain http unless allowed. It is allowed for a local stack
    // only: an issuer on a loopback address (Dex at http://127.0.0.1:5556, reached as
    // http://dex:5556). Any other http issuer is refused.
    isLocalHttp(issuer) ? { ...options, execute: [client.allowInsecureRequests] } : options,
  );
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/** The scope: OpenID Connect claims, and the API as the access token's audience (Dex). */
export function scopeFor(oidc: OidcConfig): string {
  return `openid email profile audience:server:client_id:${oidc.apiAudience}`;
}

/** A new sign-in: where to send the browser, and the flow to keep until the callback. */
export async function startSignIn(config: DashboardConfig): Promise<{ url: URL; flow: Flow }> {
  const configuration = await oidcConfiguration(config.oidc);
  const flow: Flow = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
  };
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: config.oidc.redirectUri.href,
    scope: scopeFor(config.oidc),
    code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
    code_challenge_method: 'S256',
    state: flow.state,
    nonce: flow.nonce,
  });
  return { url, flow };
}

/**
 * Finishes a sign-in. callbackUrl is the registered redirect URI with the query the
 * provider sent; flow is what the flow cookie held, or null.
 */
export async function finishSignIn(
  config: DashboardConfig,
  callbackUrl: URL,
  flow: Flow | null,
  now = new Date(),
): Promise<Session> {
  // Without the verifier the code would be sent with no PKCE proof at all.
  if (flow === null || flow.verifier === '') throw new SignInError('flow');
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    const configuration = await oidcConfiguration(config.oidc);
    tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
  } catch (error) {
    throw new SignInError(failureOf(error), { cause: error });
  }
  const claims = tokens.claims();
  const lifetime = tokens.expiresIn();
  if (claims === undefined || lifetime === undefined || lifetime <= 0) {
    throw new SignInError('provider');
  }
  return {
    accessToken: tokens.access_token,
    subject: claims.sub,
    name: typeof claims.name === 'string' ? claims.name : '',
    email: typeof claims.email === 'string' ? claims.email : '',
    expiresAt: Math.floor(now.getTime() / 1000) + lifetime,
  };
}

/** The failure, from openid-client's error or any error in its chain of causes. */
function failureOf(error: unknown): SignInFailure {
  for (let current = error; current instanceof Error; current = current.cause) {
    const cause = current.cause as { claim?: unknown } | undefined;
    if (typeof cause === 'object' && cause !== null && cause.claim === 'nonce') return 'nonce';
    if (current.message.includes('"state"')) return 'state';
  }
  return 'provider';
}
