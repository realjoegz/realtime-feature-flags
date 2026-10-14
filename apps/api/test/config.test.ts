import { describe, expect, it } from 'vitest';
import { ConfigError, describeDatabaseUrl, loadConfig, loadMigrateConfig } from '../src/config.js';

const url = 'postgres://rff_app:secret@db.internal:5432/rff';
const auth = {
  RFF_AUTH_ISSUER: 'http://127.0.0.1:5556/dex',
  RFF_AUTH_JWKS_URL: 'http://dex:5556/dex/keys',
};

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('configuration from the environment', () => {
  it('reads the API settings and applies the defaults', () => {
    expect(loadConfig({ ...auth, RFF_DATABASE_URL: url, RFF_INSTANCE: 'api-1' })).toEqual({
      http: { host: '127.0.0.1', port: 4000 },
      instance: 'api-1',
      database: { url, poolMax: 10, connectDeadlineMs: 30_000 },
      auth: {
        issuer: 'http://127.0.0.1:5556/dex',
        jwksUrl: 'http://dex:5556/dex/keys',
        audience: 'rff-api',
      },
      stream: { heartbeatMs: 15_000 },
    });
    expect(
      loadConfig({
        ...auth,
        RFF_AUTH_AUDIENCE: 'other-api',
        RFF_DATABASE_URL: url,
        RFF_HTTP_HOST: '0.0.0.0',
        RFF_HTTP_PORT: '4002',
        RFF_DB_POOL_MAX: '3',
        RFF_DB_CONNECT_DEADLINE_MS: '0',
        RFF_STREAM_HEARTBEAT_MS: '250',
      }),
    ).toMatchObject({
      http: { host: '0.0.0.0', port: 4002 },
      database: { poolMax: 3, connectDeadlineMs: 0 },
      auth: { audience: 'other-api' },
      stream: { heartbeatMs: 250 },
    });
  });

  it('reports every problem at once', () => {
    expect(
      problemsOf(() =>
        loadConfig({
          RFF_HTTP_PORT: '70000',
          RFF_DB_POOL_MAX: '0',
          RFF_DB_CONNECT_DEADLINE_MS: '1e3',
          RFF_STREAM_HEARTBEAT_MS: '5',
        }),
      ),
    ).toEqual([
      'RFF_HTTP_PORT must be an integer from 0 to 65535, got "70000"',
      'RFF_DATABASE_URL is required',
      'RFF_DB_POOL_MAX must be an integer from 1 to 1000, got "0"',
      'RFF_DB_CONNECT_DEADLINE_MS must be an integer from 0 to 600000, got "1e3"',
      'RFF_AUTH_ISSUER is required',
      'RFF_AUTH_JWKS_URL is required',
      'RFF_STREAM_HEARTBEAT_MS must be an integer from 10 to 600000, got "5"',
    ]);
  });

  it('the key set URL is an http or https URL, apart from the issuer', () => {
    const env = { ...auth, RFF_DATABASE_URL: url };
    expect(problemsOf(() => loadConfig({ ...env, RFF_AUTH_JWKS_URL: 'dex:5556' }))).toEqual([
      'RFF_AUTH_JWKS_URL must start with http:// or https://',
    ]);
    expect(problemsOf(() => loadConfig({ ...env, RFF_AUTH_JWKS_URL: 'keys' }))).toEqual([
      'RFF_AUTH_JWKS_URL is not a URL',
    ]);
    // The issuer is compared as a string, so it is kept exactly as given.
    expect(loadConfig({ ...env, RFF_AUTH_ISSUER: 'http://127.0.0.1:5556/dex/' }).auth).toEqual({
      issuer: 'http://127.0.0.1:5556/dex/',
      jwksUrl: 'http://dex:5556/dex/keys',
      audience: 'rff-api',
    });
  });

  it('accepts only postgres URLs that name a host and a database', () => {
    expect(problemsOf(() => loadConfig({ ...auth, RFF_DATABASE_URL: 'not a url' }))).toEqual([
      'RFF_DATABASE_URL is not a URL',
    ]);
    expect(problemsOf(() => loadConfig({ ...auth, RFF_DATABASE_URL: 'mysql://u@h/db' }))).toEqual([
      'RFF_DATABASE_URL must start with postgres:// or postgresql://',
    ]);
    expect(problemsOf(() => loadConfig({ ...auth, RFF_DATABASE_URL: 'postgres://u@h' }))).toEqual([
      'RFF_DATABASE_URL must name a host and a database',
    ]);
    expect(loadConfig({ ...auth, RFF_DATABASE_URL: 'postgresql://u@h/db' }).database.url).toBe(
      'postgresql://u@h/db',
    );
  });

  it('the migrate command needs the superuser URL and the app password', () => {
    expect(problemsOf(() => loadMigrateConfig({}))).toEqual([
      'RFF_MIGRATE_DATABASE_URL is required',
      'RFF_APP_DB_PASSWORD is required',
    ]);
    expect(
      problemsOf(() =>
        loadMigrateConfig({ RFF_MIGRATE_DATABASE_URL: url, RFF_APP_DB_PASSWORD: 'a\0b' }),
      ),
    ).toEqual(['RFF_APP_DB_PASSWORD must not contain a NUL character']);
    expect(loadMigrateConfig({ RFF_MIGRATE_DATABASE_URL: url, RFF_APP_DB_PASSWORD: 'pw' })).toEqual(
      {
        url,
        appPassword: 'pw',
        connectDeadlineMs: 30_000,
      },
    );
  });

  it('a database URL is logged without its password', () => {
    expect(describeDatabaseUrl(url)).toBe('rff_app@db.internal:5432/rff');
    expect(describeDatabaseUrl(url)).not.toContain('secret');
    expect(describeDatabaseUrl('postgres://h/db')).toBe('(default user)@h:5432/db');
    expect(describeDatabaseUrl('::')).toBe('(unparseable URL)');
  });
});
