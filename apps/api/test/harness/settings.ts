// Where the tests find Postgres and Redis. The defaults are the compose stack's local
// development values (compose.yaml). Roles belong to the whole Postgres server, and
// each run's migration 0001 sets rff_app's password for all of it, so the app
// password must be the one the compose replicas use. A run that changes migration
// 0001 or the roles, such as a mutation check, sets RFF_TEST_ADMIN_URL and
// RFF_TEST_REDIS_URL to servers of its own (see shared-roles.ts).

export interface HarnessSettings {
  /** Superuser, maintenance database: creates and drops each run's databases. */
  readonly serverAdminUrl: string;
  readonly redisUrl: string;
  readonly appPassword: string;
}

export function harnessSettings(
  env: Readonly<Record<string, string | undefined>>,
): HarnessSettings {
  return {
    serverAdminUrl:
      env.RFF_TEST_ADMIN_URL || 'postgres://postgres:rff-admin-local@127.0.0.1:55432/postgres',
    redisUrl: env.RFF_TEST_REDIS_URL || 'redis://127.0.0.1:56379',
    appPassword: env.RFF_APP_DB_PASSWORD || 'rff-app-local',
  };
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

export function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** A double-quoted SQL identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A single-quoted SQL string literal (standard_conforming_strings is on). */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
