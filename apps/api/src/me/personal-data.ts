import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { writeAudit } from '../audit/audit-log.js';
import type {
  MemberRole,
  TenantClient,
  TenantDatabase,
  UserMembership,
} from '../database/tenant-database.js';

// A dashboard user's personal data is the issuer, subject, email and name in users,
// and the user's memberships. GET /me/export returns all of it to the user, and
// DELETE /me erases it (migrations/0004_personal_data.sql). Audit rows hold the
// user's id and no personal field; they stay as they are.

/** Each column of users that the export holds, with its field name in the export. */
export const USER_EXPORT_FIELDS = {
  id: 'id',
  idp_issuer: 'issuer',
  idp_subject: 'subject',
  email: 'email',
  name: 'name',
} as const;

/**
 * Columns of users that the export leaves out, each with its reason. Empty: every
 * column is the user's id or personal data. A column that is in neither list fails
 * test/personal-data.test.ts.
 */
export const USER_EXPORT_EXCLUDED: Readonly<Record<string, string>> = {};

type ExportField = (typeof USER_EXPORT_FIELDS)[keyof typeof USER_EXPORT_FIELDS];

export interface PersonalDataExport {
  readonly user: Readonly<Record<ExportField, string>>;
  /** Each tenant the user belongs to, with its id, slug and name and the role. */
  readonly memberships: readonly UserMembership[];
}

// One statement, so the user and the memberships come from one snapshot. An erased
// user has no subject and gets no row.
const EXPORT = `
  SELECT ${Object.entries(USER_EXPORT_FIELDS)
    .map(([column, field]) => `u.${column} AS "${field}"`)
    .join(', ')},
         public.memberships_of_user(u.id) AS memberships
  FROM public.users u
  WHERE u.id = $1 AND u.idp_subject IS NOT NULL`;

/** The signed-in user's personal data; with no tenant set, users shows only its own row. */
export async function exportPersonalData(
  db: TenantDatabase,
  userId: string,
): Promise<PersonalDataExport> {
  const row = await db.withUser(userId, async (client) => {
    const { rows } = await client.query<
      Record<ExportField, string> & { memberships: UserMembership[] }
    >(EXPORT, [userId]);
    return rows[0];
  });
  // The guard found this user a moment ago; one erased since then is signed out.
  if (row === undefined) throw new UnauthorizedException();
  const { memberships, ...user } = row;
  return { user, memberships };
}

/**
 * Erases the signed-in user's personal data in one transaction: deletes its membership
 * in each tenant, writing one audit row there, then sets its issuer, subject, email and
 * name to NULL and keeps the row and its id. Refused with 409, and nothing changes,
 * while the user is the only owner of any of its tenants. Returns the tenants it left.
 */
export async function erasePersonalData(db: TenantDatabase, userId: string): Promise<string[]> {
  return db.withUserAcrossTenants(userId, async (client, inTenant) => {
    // Two deletions of one user take turns here, and the second finds the row erased.
    const self = await client.query<{ subject: string | null }>(
      'SELECT idp_subject AS subject FROM public.users WHERE id = $1 FOR NO KEY UPDATE',
      [userId],
    );
    if ((self.rows[0]?.subject ?? null) === null) throw new UnauthorizedException();
    const { rows } = await client.query<{ memberships: UserMembership[] }>(
      'SELECT public.memberships_of_user($1) AS memberships',
      [userId],
    );
    // In tenant id order, so that two deletions that share tenants lock them in one
    // order and cannot deadlock.
    const tenantIds = (rows[0]?.memberships ?? []).map((m) => m.tenantId).toSorted();
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one tenant at a time
      await inTenant(tenantId, (tenant) => leaveTenant(tenant, tenantId, userId));
    }
    await client.query(
      `UPDATE public.users SET idp_issuer = NULL, idp_subject = NULL, email = NULL, name = NULL
       WHERE id = $1`,
      [userId],
    );
    return tenantIds;
  });
}

/** Runs in tenantId's context: deletes the user's membership and writes its audit row. */
async function leaveTenant(client: TenantClient, tenantId: string, userId: string): Promise<void> {
  // The lock PUT /members takes: role changes and departures in one tenant take
  // turns, so the owner count read next cannot change before this transaction ends.
  await client.query('SELECT FROM public.tenants WHERE id = $1 FOR NO KEY UPDATE', [tenantId]);
  const { rows } = await client.query<{ role: MemberRole; owners: number }>(
    `SELECT m.role,
            (SELECT count(*)::int FROM public.memberships o
             WHERE o.tenant_id = $1 AND o.role = 'owner') AS owners
     FROM public.memberships m WHERE m.tenant_id = $1 AND m.user_id = $2`,
    [tenantId, userId],
  );
  const membership = rows[0];
  if (membership === undefined) throw new Error('the membership is gone');
  if (membership.role === 'owner' && membership.owners === 1) {
    throw new ConflictException(`the only owner of tenant ${tenantId} cannot leave it`);
  }
  await client.query('DELETE FROM public.memberships WHERE tenant_id = $1 AND user_id = $2', [
    tenantId,
    userId,
  ]);
  await writeAudit(client, {
    tenantId,
    actorUserId: userId,
    action: 'member.leave',
    target: userId,
    before: { role: membership.role },
    after: null,
    version: null,
  });
}
