import { vi } from 'vitest';

// The dashboard reads its settings from process.env on every call (lib/config.ts).
// Each test file sets them with vi.stubEnv, which Vitest undoes after the file.

export const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const REDIRECT_URI = 'http://127.0.0.1:3100/auth/callback';

export function useDashboardEnv(settings: {
  apiUrl?: string;
  issuer?: string;
  clientSecret?: string;
}): void {
  vi.stubEnv('RFF_API_URL', settings.apiUrl ?? 'http://127.0.0.1:9');
  vi.stubEnv('RFF_OIDC_ISSUER', settings.issuer ?? 'http://127.0.0.1:9/dex');
  vi.stubEnv('RFF_OIDC_INTERNAL_URL', '');
  vi.stubEnv('RFF_OIDC_CLIENT_ID', 'rff-dashboard');
  vi.stubEnv('RFF_OIDC_CLIENT_SECRET', settings.clientSecret ?? 'unused');
  vi.stubEnv('RFF_OIDC_REDIRECT_URI', REDIRECT_URI);
  vi.stubEnv('RFF_OIDC_API_AUDIENCE', 'rff-api');
  vi.stubEnv('RFF_SESSION_SECRET', SESSION_SECRET);
}
