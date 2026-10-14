// The dashboard's settings, read from the environment on every call, so that the
// server reads them when it runs and never at build time. A missing or malformed
// setting throws with every problem found.

export interface OidcConfig {
  /**
   * The issuer exactly as tokens carry it in "iss": the address browsers use. The
   * authorization URL that browsers are sent to is on this origin.
   */
  readonly issuer: URL;
  /**
   * Where the server itself reaches the issuer's origin, when that differs (inside
   * the compose network Dex is http://dex:5556, not 127.0.0.1:5556). Null: the same.
   */
  readonly internalOrigin: URL | null;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The callback URL registered with the identity provider. */
  readonly redirectUri: URL;
  /** The client id of the API, whose audience the access token must carry. */
  readonly apiAudience: string;
}

export interface DashboardConfig {
  /** The API's base URL, which only the server calls. No trailing slash. */
  readonly apiUrl: string;
  readonly oidc: OidcConfig;
  /** At least 32 characters; the cookie keys are derived from it. */
  readonly sessionSecret: string;
  /** Cookies get Secure when the dashboard is served over https. */
  readonly secureCookies: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): DashboardConfig {
  const problems: string[] = [];
  const text = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') problems.push(`${name} is required`);
    return value ?? '';
  };
  const url = (name: string, optional = false): URL | null => {
    const value = env[name];
    if (optional && (value === undefined || value === '')) return null;
    try {
      const parsed = new URL(text(name));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`${name} must be an http:// or https:// URL`);
      }
      return parsed;
    } catch {
      if (value !== undefined && value !== '') problems.push(`${name} is not a URL`);
      return null;
    }
  };

  const apiUrl = url('RFF_API_URL');
  const issuer = url('RFF_OIDC_ISSUER');
  const internalOrigin = url('RFF_OIDC_INTERNAL_URL', true);
  const redirectUri = url('RFF_OIDC_REDIRECT_URI');
  const sessionSecret = text('RFF_SESSION_SECRET');
  if (sessionSecret !== '' && sessionSecret.length < 32) {
    problems.push('RFF_SESSION_SECRET must be at least 32 characters');
  }
  const config = {
    apiUrl: apiUrl?.href.replace(/\/+$/, '') ?? '',
    oidc: {
      issuer: issuer ?? new URL('http://invalid'),
      internalOrigin,
      clientId: text('RFF_OIDC_CLIENT_ID'),
      clientSecret: text('RFF_OIDC_CLIENT_SECRET'),
      redirectUri: redirectUri ?? new URL('http://invalid'),
      apiAudience: env.RFF_OIDC_API_AUDIENCE || 'rff-api',
    },
    sessionSecret,
    secureCookies: redirectUri?.protocol === 'https:',
  };
  if (problems.length > 0) {
    throw new Error(`invalid dashboard configuration: ${problems.join('; ')}`);
  }
  return config;
}
