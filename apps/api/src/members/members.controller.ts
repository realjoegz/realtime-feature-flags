import { Body, ConflictException, Controller, Get, Param, Put } from '@nestjs/common';
import { writeAudit } from '../audit/audit-log.js';
import { Access, isMemberRole } from '../auth/access.js';
import { CurrentMember, type MemberScope } from '../auth/request-auth.js';
import { isUuid, type MemberRole, TenantDatabase } from '../database/tenant-database.js';
import { invalid, notFound } from '../http/errors.js';

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: MemberRole;
}

interface MemberRow {
  user_id: string;
  email: string;
  name: string;
  role: MemberRole;
}

function memberFromRow(row: MemberRow): Member {
  return { userId: row.user_id, email: row.email, name: row.name, role: row.role };
}

const MEMBER = `
  SELECT m.user_id, u.email, u.name, m.role
  FROM public.memberships m JOIN public.users u ON u.id = m.user_id
  WHERE m.tenant_id = $1`;

function roleOf(body: unknown): MemberRole {
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  const keys = isObject ? Object.keys(body) : [];
  const role = isObject ? (body as { role?: unknown }).role : undefined;
  if (keys.length !== 1 || !isMemberRole(role)) {
    throw invalid('member', ['body: must be {"role": "viewer" | "editor" | "owner"}']);
  }
  return role;
}

// Member changes write an audit row but leave the tenant's version alone: the version
// counts flag changes, which is what SDK clients follow.
@Controller('tenants/:tenantId')
export class MembersController {
  constructor(private readonly db: TenantDatabase) {}

  @Get('members')
  @Access('viewer')
  async list(@CurrentMember() member: MemberScope): Promise<{ members: Member[] }> {
    const rows = await this.db.withTenant(member, async (client) => {
      const result = await client.query<MemberRow>(
        `${MEMBER} ORDER BY u.email COLLATE "C", m.user_id`,
        [member.tenantId],
      );
      return result.rows;
    });
    return { members: rows.map(memberFromRow) };
  }

  /**
   * Changes the role of an existing member. A tenant keeps at least one owner, so
   * the last owner cannot be given another role.
   */
  @Put('members/:userId')
  @Access('owner')
  async setRole(
    @CurrentMember() member: MemberScope,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<{ member: Member }> {
    if (!isUuid(userId)) throw notFound();
    const role = roleOf(body);
    const target = userId.toLowerCase();
    const changed = await this.db.withTenant(member, async (client) => {
      // Makes role changes in one tenant take turns, so two owners who demote each
      // other at once cannot both pass the owner count below.
      await client.query('SELECT FROM public.tenants WHERE id = $1 FOR NO KEY UPDATE', [
        member.tenantId,
      ]);
      const before = await client.query<MemberRow>(`${MEMBER} AND m.user_id = $2`, [
        member.tenantId,
        target,
      ]);
      const previous = before.rows[0];
      if (previous === undefined) throw notFound();
      await client.query(
        'UPDATE public.memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2',
        [member.tenantId, target, role],
      );
      const { rows } = await client.query<{ owners: number }>(
        `SELECT count(*)::int AS owners FROM public.memberships
         WHERE tenant_id = $1 AND role = 'owner'`,
        [member.tenantId],
      );
      if (rows[0]?.owners === 0) throw new ConflictException('a tenant keeps at least one owner');
      await writeAudit(client, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        action: 'member.role',
        target,
        before: { role: previous.role },
        after: { role },
        version: null,
      });
      return { ...memberFromRow(previous), role };
    });
    return { member: changed };
  }
}
