import { hostname } from 'node:os';

// Settings come from the environment only. loadConfig reads every variable, collects
// every problem and throws them together, so one start-up names all of them.

export interface DatabaseConfig {
  /** postgres:// URL of the role the API connects as (rff_app in every deployment). */
  readonly url: string;
  readonly poolMax: number;
  /** How long start-up keeps retrying a database that does not accept connections yet. */
  readonly connectDeadlineMs: number;
}

/**
 * How bearer tokens are verified. The issuer is the exact string the identity provider
 * puts in "iss", which is the address browsers use. The key set is fetched from
 * jwksUrl, which inside the compose network is a different address for the same
 * provider, so the two are separate settings.
 */
export interface AuthConfig {
  readonly issuer: string;
  readonly jwksUrl: string;
  /** The "aud" value a token must carry. */
  readonly audience: string;
}

/** The SDK stream, GET /sdk/stream. */
export interface StreamConfig {
  /**
   * How often an open stream gets a heartbeat, a comment frame. A client that
   * receives no bytes for three intervals takes the connection for dead.
   */
  readonly heartbeatMs: number;
  /**
   * How often the instance reads the version of every tenant it has open streams
   * for, so that a change whose notification was lost still reaches them. Null
   * turns the poll off; loadConfig never does, only tests that leave notifications
   * as the one path set it.
   */
  readonly safetyPollMs: number | null;
}

/** Redis: the change notifications between instances, and the snapshot cache. */
export interface RedisConfig {
  /** redis:// or rediss:// URL. */
  readonly url: string;
  /**
   * Every key and channel of this deployment starts with the prefix and ":".
   * Instances that serve the same database share it.
   */
  readonly prefix: string;
  /** How long start-up keeps retrying a Redis that does not accept connections yet. */
  readonly connectDeadlineMs: number;
}

export interface Config {
  readonly http: { readonly host: string; readonly port: number };
  /** Name of this replica, returned by GET /health. */
  readonly instance: string;
  readonly database: DatabaseConfig;
  readonly auth: AuthConfig;
  readonly stream: StreamConfig;
  readonly redis: RedisConfig;
}

export interface MigrateConfig {
  /** postgres:// URL of the database superuser that applies the migrations. */
  readonly url: string;
  /** Password that migration 0001 sets on rff_app. */
  readonly appPassword: string;
  readonly connectDeadlineMs: number;
}

export interface SeedConfig {
  /** postgres:// URL of the database superuser that writes the demo data. */
  readonly url: string;
  /** The issuer of the demo users' tokens, exactly as Dex puts it in "iss". */
  readonly issuer: string;
  readonly connectDeadlineMs: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Segments of letters, digits, _ and - joined by ":", such as rff or rff_test_0a1b:stream. */
export const REDIS_PREFIX = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env): Config {
  const read = new Reader(env);
  const config: Config = {
    http: {
      host: read.string('RFF_HTTP_HOST', '127.0.0.1'),
      port: read.integer('RFF_HTTP_PORT', 4000, 0, 65535),
    },
    instance: read.string('RFF_INSTANCE', hostname()),
    database: {
      url: read.postgresUrl('RFF_DATABASE_URL'),
      poolMax: read.integer('RFF_DB_POOL_MAX', 10, 1, 1000),
      connectDeadlineMs: read.integer('RFF_DB_CONNECT_DEADLINE_MS', 30_000, 0, 600_000),
    },
    auth: {
      issuer: read.string('RFF_AUTH_ISSUER'),
      jwksUrl: read.httpUrl('RFF_AUTH_JWKS_URL'),
      audience: read.string('RFF_AUTH_AUDIENCE', 'rff-api'),
    },
    stream: {
      heartbeatMs: read.integer('RFF_STREAM_HEARTBEAT_MS', 15_000, 10, 600_000),
      safetyPollMs: read.integer('RFF_SAFETY_POLL_MS', 5000, 10, 600_000),
    },
    redis: {
      url: read.redisUrl('RFF_REDIS_URL'),
      prefix: read.matching(
        'RFF_REDIS_PREFIX',
        'rff',
        REDIS_PREFIX,
        'one or more segments of letters, digits, _ and - joined by ":"',
      ),
      connectDeadlineMs: read.integer('RFF_REDIS_CONNECT_DEADLINE_MS', 30_000, 0, 600_000),
    },
  };
  read.done();
  return config;
}

export function loadMigrateConfig(env: Env): MigrateConfig {
  const read = new Reader(env);
  const config: MigrateConfig = {
    url: read.postgresUrl('RFF_MIGRATE_DATABASE_URL'),
    appPassword: read.secret('RFF_APP_DB_PASSWORD'),
    connectDeadlineMs: read.integer('RFF_DB_CONNECT_DEADLINE_MS', 30_000, 0, 600_000),
  };
  read.done();
  return config;
}

export function loadSeedConfig(env: Env): SeedConfig {
  const read = new Reader(env);
  const config: SeedConfig = {
    url: read.postgresUrl('RFF_SEED_DATABASE_URL'),
    issuer: read.string('RFF_SEED_ISSUER'),
    connectDeadlineMs: read.integer('RFF_DB_CONNECT_DEADLINE_MS', 30_000, 0, 600_000),
  };
  read.done();
  return config;
}

/** user@host:port/database, without the password, for log lines and errors. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = decodeURIComponent(parsed.username) || '(default user)';
    return `${user}@${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

/** host:port of a Redis URL, without its credentials, for log lines and errors. */
export function describeRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return '(unparseable URL)';
  }
}

class Reader {
  private readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  string(name: string, fallback?: string): string {
    const value = this.env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    this.problems.push(`${name} is required`);
    return '';
  }

  secret(name: string): string {
    const value = this.string(name);
    if (value.includes('\0')) this.problems.push(`${name} must not contain a NUL character`);
    return value;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      this.problems.push(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
      return fallback;
    }
    return Number(raw);
  }

  postgresUrl(name: string): string {
    const value = this.string(name);
    if (value === '') return value;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.problems.push(`${name} is not a URL`);
      return value;
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      this.problems.push(`${name} must start with postgres:// or postgresql://`);
    } else if (parsed.hostname === '' || parsed.pathname.length < 2) {
      this.problems.push(`${name} must name a host and a database`);
    }
    return value;
  }

  matching(name: string, fallback: string, pattern: RegExp, description: string): string {
    const value = this.string(name, fallback);
    if (!pattern.test(value)) this.problems.push(`${name} must be ${description}, got "${value}"`);
    return value;
  }

  redisUrl(name: string): string {
    const value = this.string(name);
    if (value === '') return value;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.problems.push(`${name} is not a URL`);
      return value;
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      this.problems.push(`${name} must start with redis:// or rediss://`);
    } else if (parsed.hostname === '') {
      this.problems.push(`${name} must name a host`);
    }
    return value;
  }

  httpUrl(name: string): string {
    const value = this.string(name);
    if (value === '') return value;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.problems.push(`${name} is not a URL`);
      return value;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.problems.push(`${name} must start with http:// or https://`);
    }
    return value;
  }

  done(): void {
    if (this.problems.length > 0) throw new ConfigError(this.problems);
  }
}
