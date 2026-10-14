import { createHash, randomBytes } from 'node:crypto';
import { Controller, Post } from '@nestjs/common';
import { writeAudit } from '../audit/audit-log.js';
import { Access } from '../auth/access.js';
import { CurrentMember, type MemberScope } from '../auth/request-auth.js';
import { TenantDatabase } from '../database/tenant-database.js';

export interface CreatedSdkKey {
  readonly id: string;
  /** Returned once, in this response. The database holds only its SHA-256. */
  readonly key: string;
  readonly createdAt: string;
}

/** rff_sdk_ and 32 random bytes in base64url. */
export function newSdkKey(): { key: string; hash: Buffer } {
  const key = `rff_sdk_${randomBytes(32).toString('base64url')}`;
  return { key, hash: createHash('sha256').update(key).digest() };
}

@Controller('tenants/:tenantId')
export class SdkKeysController {
  constructor(private readonly db: TenantDatabase) {}

  @Post('sdk-keys')
  @Access('owner')
  async create(@CurrentMember() member: MemberScope): Promise<CreatedSdkKey> {
    const { key, hash } = newSdkKey();
    return this.db.withTenant(member, async (client) => {
      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO public.sdk_keys (tenant_id, key_hash) VALUES ($1, $2)
         RETURNING id, created_at`,
        [member.tenantId, hash],
      );
      const created = rows[0] as { id: string; created_at: Date };
      // The audit row names the key by id; neither the key nor its hash is in it.
      await writeAudit(client, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        action: 'sdk_key.create',
        target: created.id,
        before: null,
        after: { id: created.id },
        version: null,
      });
      return { id: created.id, key, createdAt: created.created_at.toISOString() };
    });
  }
}
