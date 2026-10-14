import { Controller, Get, Query } from '@nestjs/common';
import { Access } from '../auth/access.js';
import { CurrentMember, type MemberScope } from '../auth/request-auth.js';
import { TenantDatabase } from '../database/tenant-database.js';
import { bigintFromText } from '../flags/flag-store.js';
import { invalid } from '../http/errors.js';
import type { AuditAction } from './audit-log.js';

export interface AuditRecord {
  readonly id: number;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly version: number | null;
  readonly at: string;
}

interface AuditRow {
  id: string;
  actor_user_id: string;
  action: AuditAction;
  target: string;
  before: unknown;
  after: unknown;
  version: string | null;
  at: Date;
}

export const AUDIT_PAGE = 100;

@Controller('tenants/:tenantId')
export class AuditController {
  constructor(private readonly db: TenantDatabase) {}

  /**
   * The tenant's audit rows, newest first, at most 100. ?before=<id> gives the rows
   * older than that id, for the next page. The ids come from one sequence shared by
   * all tenants (migrations/0002_tenancy.sql): the gap between two of a tenant's ids
   * is the number of audit rows other tenants wrote in between, and nothing else
   * about those rows shows.
   */
  @Get('audit')
  @Access('viewer')
  async list(
    @CurrentMember() member: MemberScope,
    @Query('before') before?: unknown,
  ): Promise<{ entries: AuditRecord[] }> {
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,15}$/.test(before))) {
      throw invalid('query', ['before: must be an audit row id']);
    }
    const rows = await this.db.withTenant(member, async (client) => {
      const result = await client.query<AuditRow>(
        // Sorted by the bigint column a.id, not by the text column id of the output.
        `SELECT a.id::text AS id, a.actor_user_id, a.action, a.target, a.before, a.after,
                a.version::text AS version, a.at
         FROM public.audit_log a
         WHERE a.tenant_id = $1 AND ($2::bigint IS NULL OR a.id < $2::bigint)
         ORDER BY a.id DESC
         LIMIT ${AUDIT_PAGE}`,
        [member.tenantId, before ?? null],
      );
      return result.rows;
    });
    return {
      entries: rows.map((row) => ({
        id: bigintFromText(row.id),
        actorUserId: row.actor_user_id,
        action: row.action,
        target: row.target,
        before: row.before,
        after: row.after,
        version: row.version === null ? null : bigintFromText(row.version),
        at: row.at.toISOString(),
      })),
    };
  }
}
