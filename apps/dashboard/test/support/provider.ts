import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// A small OpenID provider on 127.0.0.1 for the sign-in tests: discovery, a token
// endpoint that checks the client's secret and the PKCE code verifier against the
// challenge (S256) as Dex does, and a key set. The tests play the browser: authorize()
// reads the authorization URL the login route sent the browser to, and returns the
// callback URL the provider would redirect to, with a code bound to that request.

export interface Provider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Token requests received, accepted or not. */
  readonly tokenRequests: number;
  /** The access token of every accepted token request. */
  readonly accessTokens: readonly string[];
  /**
   * The callback URL for an authorization request. nonce replaces the request's
   * nonce in the ID token, for a test that needs it wrong.
   */
  authorize(authorizationUrl: string, options?: { nonce?: string }): URL;
  close(): Promise<void>;
}

interface Grant {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | undefined;
}

async function formOf(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function formDecoded(part: string): string {
  return decodeURIComponent(part.replaceAll('+', ' '));
}

/**
 * Client authentication with HTTP Basic: the id and secret each form-urlencoded, then
 * joined by ":" and base64-encoded (RFC 6749, section 2.3.1).
 */
function basicAuthIs(header: string | undefined, id: string, secret: string): boolean {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (match === null) return false;
  const [user = '', password = ''] = Buffer.from(match[1] ?? '', 'base64')
    .toString('utf8')
    .split(':');
  return formDecoded(user) === id && formDecoded(password) === secret;
}

export async function startProvider(): Promise<Provider> {
  const clientId = 'rff-dashboard';
  const clientSecret = 'test-client-secret';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const kid = randomBytes(4).toString('hex');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };
  const grants = new Map<string, Grant>();
  const accessTokens: string[] = [];
  let tokenRequests = 0;
  let issuer = '';

  const sign = (claims: Record<string, unknown>): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  const server: Server = createServer((request, response) => {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      if (request.method === 'GET' && request.url === '/.well-known/openid-configuration') {
        json(200, {
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      } else if (request.method === 'GET' && request.url === '/keys') {
        json(200, jwks);
      } else if (request.method === 'POST' && request.url === '/token') {
        tokenRequests += 1;
        const form = await formOf(request);
        const grant = grants.get(form.get('code') ?? '');
        grants.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!basicAuthIs(request.headers.authorization, clientId, clientSecret)) {
          json(401, { error: 'invalid_client' });
        } else if (
          form.get('grant_type') !== 'authorization_code' ||
          grant === undefined ||
          grant.redirectUri !== form.get('redirect_uri')
        ) {
          json(400, { error: 'invalid_grant' });
        } else if (verifier === '' || challenge !== grant.challenge) {
          json(400, { error: 'invalid_grant', error_description: 'Invalid code_verifier.' });
        } else {
          const subject = 'user-1';
          const accessToken = await sign({ sub: subject, aud: ['rff-api', clientId] });
          accessTokens.push(accessToken);
          json(200, {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: 300,
            id_token: await sign({
              sub: subject,
              aud: clientId,
              nonce: grant.nonce,
              email: 'user-1@example.test',
              name: 'User One',
            }),
          });
        }
      } else {
        json(404, { error: 'not_found' });
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    get tokenRequests() {
      return tokenRequests;
    },
    accessTokens,
    authorize(authorizationUrl, options = {}) {
      const url = new URL(authorizationUrl);
      const params = url.searchParams;
      if (url.origin !== issuer || url.pathname !== '/auth') {
        throw new Error(`not this provider's authorization endpoint: ${authorizationUrl}`);
      }
      if (params.get('client_id') !== clientId || params.get('response_type') !== 'code') {
        throw new Error(`unexpected authorization request: ${authorizationUrl}`);
      }
      if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) {
        throw new Error('PKCE is required');
      }
      const code = randomBytes(16).toString('base64url');
      const redirectUri = params.get('redirect_uri') ?? '';
      grants.set(code, {
        redirectUri,
        challenge: params.get('code_challenge') ?? '',
        nonce: options.nonce ?? params.get('nonce') ?? undefined,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = params.get('state');
      if (state !== null) callback.searchParams.set('state', state);
      return callback;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
