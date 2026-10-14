import type { TenantClient } from '../database/tenant-database.js';

// One audit row per change, written in the change's own transaction, so a change
// and its row commit together or not at all. rff_app holds only INSERT and SELECT
// on audit_log: a row cannot be changed or removed through the API's role. A row
// names its actor by user id only, never by name or email. DELETE /me erases a user's
// name, email, issuer and subject and keeps the id, so the rows stay as they are and
// their actor id then maps to no person.

export type AuditAction =
  'flag.create' | 'flag.update' | 'flag.delete' | 'member.role' | 'member.leave' | 'sdk_key.create';

export interface AuditEntry {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly action: AuditAction;
  /**
   * The flag key, the member's user id or the SDK key's id. member.leave, written by
   * DELETE /me, names the user who left, who is also the actor.
   */
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  /** The tenant version a flag write produced; null for member and SDK key changes. */
  readonly version: number | null;
}

export async function writeAudit(client: TenantClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO public.audit_log (tenant_id, actor_user_id, action, target, before, after, version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      entry.tenantId,
      entry.actorUserId,
      entry.action,
      entry.target,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
      entry.version,
    ],
  );
}
