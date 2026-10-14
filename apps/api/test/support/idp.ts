import { createHmac, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  base64url,
  type CryptoKey,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from 'jose';

// A local identity provider for the API tests: key pairs made for the test run, a
// key set served over HTTP on 127.0.0.1, and a function that signs tokens. The API
// verifies them with its own code (src/auth/token-verifier.ts), fetching the key set
// from this server as it would from Dex, so the tests can send tokens that Dex never
// would: expired, for another audience, signed by an unknown key, unsigned.

export const AUDIENCE = 'rff-api';

/** The algorithms the test keys sign with. The API accepts only RS256 and ES256. */
export type SigningAlg = 'RS256' | 'ES256' | 'RS384' | 'PS256';

interface SigningKey {
  readonly kid: string;
  /** The algorithm the key signs with by default, and its "alg" in the key set. */
  readonly alg: 'RS256' | 'ES256';
  /** Whether the key set lists the key with its "alg" member. */
  readonly pinned: boolean;
  readonly privateKey: CryptoKey | KeyObject;
  readonly publicKey: CryptoKey | KeyObject;
}

/**
 * rsa and ec are in the key set with "alg" RS256 and ES256. unpinned is an RSA key in
 * the key set without an "alg" member, which RFC 7517 allows: the key set then does
 * not limit the algorithms it verifies, and only the API's own list refuses RS384
 * or PS256 signed with it. outsider's key is not in the key set.
 */
export type KeyName = 'rsa' | 'ec' | 'unpinned' | 'outsider';

export interface TokenOptions {
  /** The key that signs it. Default rsa. */
  readonly key?: KeyName;
  /** The algorithm, when it should differ from the key's: RS384 or PS256 for an RSA key. */
  readonly alg?: SigningAlg;
  /** Claims that replace or add to the defaults; undefined removes a claim. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** The kid header, when it should differ from the signing key's. */
  readonly kid?: string;
}

export interface LocalIdp {
  /** The "iss" of its tokens. The key set lives at another address, jwksUrl. */
  readonly issuer: string;
  readonly jwksUrl: string;
  /** How many times the key set was fetched. */
  readonly fetches: number;
  /** A signed token for subject: iss, aud, sub, iat and exp (5 minutes ahead) by default. */
  token(subject: string, options?: TokenOptions): Promise<string>;
  /**
   * A token whose protected header is the rsa key's (alg RS256, kid, typ JWT) with
   * header's members added, and whose payload is the JSON of payload, signed RS256 by
   * the rsa key. For headers and payloads that SignJWT refuses to produce.
   */
  rawToken(header: Readonly<Record<string, unknown>>, payload: unknown): Promise<string>;
  /** The claims a token for subject carries by default. */
  claims(subject: string): JWTPayload;
  /** The RSA public key, as PEM, which an HS256 key-confusion attack uses as its secret. */
  readonly rsaPublicKeyPem: string;
  /** The kid of the key in the key set that signs RS256 tokens. */
  readonly rsaKid: string;
  /** When false, the key set answers 503 and the API cannot check any token. */
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

async function signingKey(alg: SigningKey['alg']): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  return { kid: randomUUID(), alg, pinned: true, privateKey, publicKey };
}

/** An RSA key as Node KeyObjects, which jose signs with any RSA algorithm. */
function unpinnedRsaKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: randomUUID(), alg: 'RS256', pinned: false, privateKey, publicKey };
}

export async function startIdp(issuer = 'https://idp.example.test'): Promise<LocalIdp> {
  const keys: Record<KeyName, SigningKey> = {
    rsa: await signingKey('RS256'),
    ec: await signingKey('ES256'),
    unpinned: unpinnedRsaKey(),
    outsider: await signingKey('RS256'),
  };
  const published = {
    keys: await Promise.all(
      [keys.rsa, keys.ec, keys.unpinned].map(async (key) =>
        Object.assign(
          await exportJWK(key.publicKey),
          { kid: key.kid, use: 'sig' },
          key.pinned ? { alg: key.alg } : {},
        ),
      ),
    ),
  };
  let available = true;
  let fetches = 0;
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/keys') {
      response.writeHead(404).end();
      return;
    }
    fetches += 1;
    if (!available) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/jwk-set+json' });
    response.end(JSON.stringify(published));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const claims = (subject: string): JWTPayload => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: issuer, aud: AUDIENCE, sub: subject, iat: now, exp: now + 300 };
  };

  return {
    issuer,
    jwksUrl: `http://127.0.0.1:${port}/keys`,
    get fetches() {
      return fetches;
    },
    claims,
    async token(subject, options = {}) {
      const key = keys[options.key ?? 'rsa'];
      const payload: Record<string, unknown> = { ...claims(subject), ...options.claims };
      for (const [name, value] of Object.entries(payload)) {
        if (value === undefined) delete payload[name];
      }
      return new SignJWT(payload as JWTPayload)
        .setProtectedHeader({
          alg: options.alg ?? key.alg,
          kid: options.kid ?? key.kid,
          typ: 'JWT',
        })
        .sign(key.privateKey);
    },
    async rawToken(header, payload) {
      const input = `${encodeSegment({ alg: 'RS256', kid: keys.rsa.kid, typ: 'JWT', ...header })}.${encodeSegment(payload)}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.rsa.privateKey as CryptoKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${base64url.encode(new Uint8Array(signature))}`;
    },
    rsaPublicKeyPem: await exportSPKI(keys.rsa.publicKey),
    rsaKid: keys.rsa.kid,
    setAvailable(value) {
      available = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function encodeSegment(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}

/** A token with "alg": "none" and an empty signature. */
export function unsignedToken(payload: JWTPayload): string {
  return `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(payload)}.`;
}

/**
 * A token signed with HMAC-SHA256 using secret, for example the RSA public key: a
 * verifier that let the token choose the algorithm would check it with that key as
 * the HMAC secret and accept it.
 */
export function hmacToken(payload: JWTPayload, secret: string, kid: string): string {
  const input = `${encodeSegment({ alg: 'HS256', typ: 'JWT', kid })}.${encodeSegment(payload)}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}
