import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify, type JWSAlgorithm } from 'jose';
import { type Config } from '../config.js';
import { CONFIG } from '../tokens.js';

// Bearer tokens are JWTs signed by the identity provider. A token is accepted only
// when its signature verifies with a key from the provider's key set, its algorithm
// is RS256 or ES256, "iss" is exactly the configured issuer, "aud" includes the
// configured audience, it has "sub" and "exp", and it is inside its "nbf" and "exp".
// The algorithm list keeps out "none" and HS256 signed with a public key as secret.

export const ALGORITHMS: readonly JWSAlgorithm[] = ['RS256', 'ES256'];

export interface VerifiedToken {
  /** The configured issuer, which the token's "iss" equals. */
  readonly issuer: string;
  readonly subject: string;
}

/** The token is not acceptable. Answered with 401. */
export class TokenRejectedError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`token rejected: ${reason}`, options);
    this.name = 'TokenRejectedError';
  }
}

/** The key set could not be fetched or read, so no token can be checked. Answered with 503. */
export class KeySetUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`the identity provider's key set is unavailable: ${messageOf(cause)}`, { cause });
    this.name = 'KeySetUnavailableError';
  }
}

// Failures that come from the token itself. Every other failure (a timeout, a
// response that is not 200 or not a key set, a network error) is about the key set.
const TOKEN_FAULTS: ReadonlySet<string> = new Set([
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWSInvalid.code,
  errors.JWTInvalid.code,
  errors.JWTExpired.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
]);

@Injectable()
export class TokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    // Fetched on the first verification and cached; an unknown "kid" fetches again
    // at most every 30 s.
    this.keys = createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 5000 });
  }

  async verify(token: string): Promise<VerifiedToken> {
    const { issuer, audience } = this.config.auth;
    let subject: unknown;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer,
        audience,
        algorithms: [...ALGORITHMS],
        requiredClaims: ['sub', 'exp'],
      });
      subject = payload.sub;
    } catch (error) {
      if (error instanceof errors.JOSEError && TOKEN_FAULTS.has(error.code)) {
        throw new TokenRejectedError(error.code, { cause: error });
      }
      throw new KeySetUnavailableError(error);
    }
    if (typeof subject !== 'string' || subject === '') {
      throw new TokenRejectedError('"sub" is empty');
    }
    return { issuer, subject };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
