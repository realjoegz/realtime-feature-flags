import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../tokens.js';

// Every read and write of tenant data goes through withTenant. Row-level security
// (migrations/0002_tenancy.sql) shows a transaction only the rows of the tenant in
// app.tenant_id, and set_config(..., true) scopes that setting to the transaction,
// so a pooled connection carries nothing into its next use. The settings are never
// set with a session-level SET, and BEGIN never goes through pool.query, which could
// run each statement on a different connection.
//
// The look-ups run before the tenant is known, or across tenants, through SECURITY
// DEFINER functions that return one value each.

export interface TenantScope {
  /** The tenant from the route path, already checked against the membership. */
  readonly tenantId: string;
  /** The signed-in user, or null for a request made with an SDK key. */
  readonly userId: string | null;
}

/**
 * What fn gets: queries on the transaction's connection, and no way to release it.
 * Once fn has returned or thrown, every query is refused, because the connection may
 * already be running another caller's transaction.
 */
export interface TenantClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string | pg.QueryConfig,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export const TRANSACTION_ENDED =
  'withTenant: the transaction has ended; every query must finish before fn returns';

export const TRANSACTION_ABORTED =
  'withTenant: a statement failed inside fn, so COMMIT rolled the transaction back';

export type MemberRole = 'viewer' | 'editor' | 'owner';

export interface UserMembership {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: MemberRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

const SET_SCOPE =
  "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)";

@Injectable()
export class TenantDatabase {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Runs fn in one transaction on one pooled connection, with app.tenant_id and
   * app.user_id set for that transaction only. Commits when fn resolves and rolls
   * back when it throws, then returns the connection to the pool, or discards it when
   * the connection failed. A query that fn sends after it has returned or thrown is
   * rejected with TRANSACTION_ENDED and never reaches the connection.
   */
  async withTenant<T>(scope: TenantScope, fn: (client: TenantClient) => Promise<T>): Promise<T> {
    // A value that is not a UUID would make every policy's ::uuid cast fail.
    if (!isUuid(scope.tenantId)) throw new TypeError('withTenant: tenantId is not a UUID');
    if (scope.userId !== null && !isUuid(scope.userId)) {
      throw new TypeError('withTenant: userId is neither null nor a UUID');
    }
    return this.transaction(scope.tenantId, scope.userId ?? '', fn);
  }

  /**
   * Runs fn like withTenant, with app.user_id set and app.tenant_id empty, for a
   * request that is about the signed-in user and no tenant (GET /me). Every tenant
   * table then reads as empty; users shows the user's own row.
   */
  async withUser<T>(userId: string, fn: (client: TenantClient) => Promise<T>): Promise<T> {
    if (!isUuid(userId)) throw new TypeError('withUser: userId is not a UUID');
    return this.transaction('', userId, fn);
  }

  private async transaction<T>(
    tenantSetting: string,
    userSetting: string,
    fn: (client: TenantClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    // The pool listens for errors only on idle clients. A connection that drops while
    // checked out emits 'error' on the client, which would otherwise be uncaught.
    let broken: Error | undefined;
    const onError = (error: Error): void => {
      broken = error;
    };
    client.on('error', onError);
    // A query that fn starts and does not await (a missing await, or a Promise.all
    // branch still running after another one threw) would otherwise go out on this
    // connection after it is released, inside whatever transaction runs there next.
    let open = true;
    const scoped: TenantClient = {
      query: (text, values) =>
        open ? client.query(text, values) : Promise.reject(new Error(TRANSACTION_ENDED)),
    };
    try {
      try {
        await client.query('BEGIN');
      } catch (error) {
        // BEGIN fails only when the connection is gone or unusable.
        broken ??= asError(error);
        throw error;
      }
      try {
        await client.query(SET_SCOPE, [tenantSetting, userSetting]);
        let result: T;
        try {
          result = await fn(scoped);
        } finally {
          open = false;
        }
        // COMMIT of a transaction in which a statement failed rolls it back and
        // reports ROLLBACK without an error. That happens when fn catches the failure
        // and returns, and the caller must not take it for a commit.
        const commit = await client.query('COMMIT');
        if (commit.command !== 'COMMIT') throw new Error(TRANSACTION_ABORTED);
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken ??= asError(rollbackError);
        }
        throw error;
      }
    } finally {
      client.removeListener('error', onError);
      // With an error, the pool closes the connection instead of handing it out again.
      client.release(broken);
    }
  }

  /** The user signed in at issuer as subject, or null. */
  async userIdForSubject(issuer: string, subject: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>(
      'SELECT public.user_id_for_subject($1, $2) AS id',
      [issuer, subject],
    );
    return rows[0]?.id ?? null;
  }

  /** The user's role in the tenant, or null when the user is not a member. */
  async memberRole(userId: string, tenantId: string): Promise<MemberRole | null> {
    // A route parameter that is not a UUID names no tenant, as an unknown one does.
    if (!isUuid(userId) || !isUuid(tenantId)) return null;
    const { rows } = await this.pool.query<{ role: MemberRole | null }>(
      'SELECT public.member_role_in_tenant($1, $2) AS role',
      [userId, tenantId],
    );
    return rows[0]?.role ?? null;
  }

  /** The tenants the user is a member of, with the role in each, ordered by slug. */
  async membershipsOf(userId: string): Promise<UserMembership[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.pool.query<{ memberships: UserMembership[] | null }>(
      'SELECT public.memberships_of_user($1) AS memberships',
      [userId],
    );
    return rows[0]?.memberships ?? [];
  }

  /** The tenant of the unrevoked SDK key whose SHA-256 is keyHash, or null. */
  async tenantIdForSdkKeyHash(keyHash: Uint8Array): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>(
      'SELECT public.tenant_id_for_sdk_key($1) AS id',
      [Buffer.from(keyHash)],
    );
    return rows[0]?.id ?? null;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
