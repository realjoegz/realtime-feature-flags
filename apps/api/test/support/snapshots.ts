import type { Flag, Rule } from '@rff/core';
import type pg from 'pg';

// A tenant's version and flags read on the superuser connection, which skips
// row-level security: what a snapshot of the tenant must hold. The mapping from
// rows to flags is written here again rather than taken from src/flags.

export interface DatabaseSnapshot {
  readonly tenantId: string;
  readonly version: number;
  readonly flags: Flag[];
}

export async function databaseSnapshot(
  admin: pg.ClientBase,
  tenantId: string,
): Promise<DatabaseSnapshot> {
  const tenant = await admin.query<{ version: string }>(
    'SELECT version::text FROM public.tenants WHERE id = $1',
    [tenantId],
  );
  const flags = await admin.query<{
    key: string;
    enabled: boolean;
    salt: string;
    rules: Rule[];
    rollout_bp: number;
  }>(
    `SELECT key, enabled, salt, rules, rollout_bp FROM public.flags
     WHERE tenant_id = $1 ORDER BY key COLLATE "C"`,
    [tenantId],
  );
  const version = tenant.rows[0]?.version;
  if (version === undefined) throw new Error(`no tenant ${tenantId}`);
  return {
    tenantId,
    version: Number(version),
    flags: flags.rows.map((row) => ({
      key: row.key,
      enabled: row.enabled,
      salt: row.salt,
      rules: row.rules,
      rolloutBasisPoints: row.rollout_bp,
    })),
  };
}

/** Polls every 10 ms until condition holds, or rejects after timeoutMs. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  // eslint-disable-next-line no-await-in-loop -- polling
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms: ${what}`);
    // eslint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
