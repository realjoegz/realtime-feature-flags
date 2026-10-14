import type { Flag, Rule } from '@rff/core';
import type { TenantClient } from '../database/tenant-database.js';

// SQL for flags and versions, run inside withTenant. Every statement names the
// tenant as well, although row-level security already limits it to the current one.

export interface FlagRow {
  key: string;
  enabled: boolean;
  salt: string;
  rules: Rule[];
  rollout_bp: number;
}

export const FLAG_COLUMNS = 'key, enabled, salt, rules, rollout_bp';

/** A row as a Flag, with each rule's properties in the order Rule declares them. */
export function flagFromRow(row: FlagRow): Flag {
  return {
    key: row.key,
    enabled: row.enabled,
    salt: row.salt,
    rules: row.rules.map(({ attribute, operator, values, serve }) => ({
      attribute,
      operator,
      values,
      serve,
    })),
    rolloutBasisPoints: row.rollout_bp,
  };
}

/** A bigint column read as text, as a number. Versions and ids stay far below 2^53. */
export function bigintFromText(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`not a safe integer: ${text}`);
  return value;
}

/**
 * Adds one to the tenant's version and returns the new value. It is the first
 * statement of every flag write: the row lock it takes makes the writers of one
 * tenant commit one after another, so versions have no gaps and each version names
 * exactly one change. Null when the tenant does not exist.
 */
export async function bumpVersion(client: TenantClient, tenantId: string): Promise<number | null> {
  const { rows } = await client.query<{ version: string }>(
    'UPDATE public.tenants SET version = version + 1 WHERE id = $1 RETURNING version::text',
    [tenantId],
  );
  const row = rows[0];
  return row === undefined ? null : bigintFromText(row.version);
}

/** The tenant's current version, or null when the tenant does not exist. */
export async function readVersion(client: TenantClient, tenantId: string): Promise<number | null> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version::text FROM public.tenants WHERE id = $1',
    [tenantId],
  );
  const row = rows[0];
  return row === undefined ? null : bigintFromText(row.version);
}

export interface Snapshot {
  readonly tenantId: string;
  readonly version: number;
  /** Ordered by key, in byte order. */
  readonly flags: readonly Flag[];
}

/**
 * The tenant's version and all its flags, from one statement and so from one
 * snapshot of the database: the flags are exactly those of that version. Null when
 * the tenant does not exist.
 */
export async function readSnapshot(
  client: TenantClient,
  tenantId: string,
): Promise<Snapshot | null> {
  const { rows } = await client.query<
    { version: string } & { [K in keyof FlagRow]: FlagRow[K] | null }
  >(
    `SELECT t.version::text AS version, f.key, f.enabled, f.salt, f.rules, f.rollout_bp
     FROM public.tenants t
     LEFT JOIN public.flags f ON f.tenant_id = t.id
     WHERE t.id = $1
     ORDER BY f.key COLLATE "C"`,
    [tenantId],
  );
  const first = rows[0];
  if (first === undefined) return null;
  const flags = rows.flatMap((row) => (row.key === null ? [] : [flagFromRow(row as FlagRow)]));
  return { tenantId, version: bigintFromText(first.version), flags };
}
