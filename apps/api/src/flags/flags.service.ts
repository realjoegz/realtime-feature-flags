import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { evaluate, type Context, type Evaluation, type Flag } from '@rff/core';
import { writeAudit } from '../audit/audit-log.js';
import type { MemberScope } from '../auth/request-auth.js';
import { TenantDatabase, type TenantClient } from '../database/tenant-database.js';
import { notFound } from '../http/errors.js';
import { SnapshotReader } from '../stream/snapshot-reader.js';
import { bumpVersion, FLAG_COLUMNS, flagFromRow, type FlagRow } from './flag-store.js';
import { FlagsCache } from './flags-cache.js';
import { FLAGS_NOTIFIER, type FlagsChange, type FlagsNotifier } from './notifier.js';

/** What a client may set on a flag. The key comes from the path or the body, the salt from here. */
export interface FlagSettings {
  readonly enabled: boolean;
  readonly rules: Flag['rules'];
  readonly rolloutBasisPoints: number;
}

export interface FlagWrite {
  readonly version: number;
  readonly flag: Flag;
}

export type EvaluationResult = Evaluation & { readonly flagKey: string };

/** 16 hex digits, from 8 random bytes. Set once when a flag is created. */
export function newSalt(): string {
  return randomBytes(8).toString('hex');
}

// Every flag write is one withTenant transaction: the version bump first, then the
// change, then its audit row carrying the new version. Anything that fails inside
// rolls all three back. Only after COMMIT does the write delete the cache entry of
// the version before it and notify every instance; neither can fail the write.
// GET /flags and POST /evaluate read through SnapshotReader, and so the cache.
@Injectable()
export class FlagsService {
  private readonly logger = new Logger('Flags');

  constructor(
    private readonly db: TenantDatabase,
    @Inject(FLAGS_NOTIFIER) private readonly notifier: FlagsNotifier,
    private readonly reader: SnapshotReader,
    private readonly cache: FlagsCache,
  ) {}

  async list(member: MemberScope): Promise<{ version: number; flags: readonly Flag[] }> {
    const snapshot = await this.reader.current(member);
    if (snapshot === null) throw notFound();
    return { version: snapshot.version, flags: snapshot.flags };
  }

  async get(member: MemberScope, key: string): Promise<Flag> {
    const flag = await this.db.withTenant(member, (client) => findFlag(client, member, key));
    if (flag === null) throw notFound();
    return flag;
  }

  async create(member: MemberScope, flag: Flag): Promise<FlagWrite> {
    return this.write(member, async (client, version) => {
      const { rows } = await client.query<FlagRow>(
        `INSERT INTO public.flags (tenant_id, key, enabled, salt, rules, rollout_bp)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id, key) DO NOTHING
         RETURNING ${FLAG_COLUMNS}`,
        [
          member.tenantId,
          flag.key,
          flag.enabled,
          flag.salt,
          JSON.stringify(flag.rules),
          flag.rolloutBasisPoints,
        ],
      );
      const created = rows[0];
      if (created === undefined) throw new ConflictException('a flag with this key exists');
      const after = flagFromRow(created);
      await writeAudit(client, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        action: 'flag.create',
        target: after.key,
        before: null,
        after,
        version,
      });
      return after;
    });
  }

  /** Replaces enabled, rules and the rollout. The key and the salt never change. */
  async update(member: MemberScope, key: string, settings: FlagSettings): Promise<FlagWrite> {
    return this.write(member, async (client, version) => {
      const before = await findFlag(client, member, key);
      if (before === null) throw notFound();
      const { rows } = await client.query<FlagRow>(
        `UPDATE public.flags
         SET enabled = $3, rules = $4::jsonb, rollout_bp = $5, updated_at = now()
         WHERE tenant_id = $1 AND key = $2
         RETURNING ${FLAG_COLUMNS}`,
        [
          member.tenantId,
          key,
          settings.enabled,
          JSON.stringify(settings.rules),
          settings.rolloutBasisPoints,
        ],
      );
      const after = flagFromRow(rows[0] as FlagRow);
      await writeAudit(client, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        action: 'flag.update',
        target: key,
        before,
        after,
        version,
      });
      return after;
    });
  }

  async remove(member: MemberScope, key: string): Promise<{ version: number }> {
    const written = await this.write(member, async (client, version) => {
      const { rows } = await client.query<FlagRow>(
        `DELETE FROM public.flags WHERE tenant_id = $1 AND key = $2 RETURNING ${FLAG_COLUMNS}`,
        [member.tenantId, key],
      );
      const removed = rows[0];
      if (removed === undefined) throw notFound();
      const before = flagFromRow(removed);
      await writeAudit(client, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        action: 'flag.delete',
        target: key,
        before,
        after: null,
        version,
      });
      return before;
    });
    return { version: written.version };
  }

  /** Every flag of the tenant evaluated for context, at one version. */
  async evaluate(
    member: MemberScope,
    context: Context,
  ): Promise<{ version: number; results: EvaluationResult[] }> {
    const { version, flags } = await this.list(member);
    return {
      version,
      results: flags.map((flag) => Object.assign({ flagKey: flag.key }, evaluate(flag, context))),
    };
  }

  private async write(
    member: MemberScope,
    change: (client: TenantClient, version: number) => Promise<Flag>,
  ): Promise<FlagWrite> {
    const result = await this.db.withTenant(member, async (client) => {
      const version = await bumpVersion(client, member.tenantId);
      if (version === null) throw notFound();
      return { version, flag: await change(client, version) };
    });
    await Promise.all([
      // FlagsCache logs its own failures and never throws.
      this.cache.forget(member.tenantId, result.version - 1),
      this.notify({ tenantId: member.tenantId, version: result.version }),
    ]);
    return result;
  }

  private async notify(change: FlagsChange): Promise<void> {
    try {
      await this.notifier.flagsChanged(change);
    } catch (error) {
      // The change is committed; a stream that misses this notification finds the
      // new version at the next safety poll or on its next connection.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`notifying version ${change.version} failed: ${message}`);
    }
  }
}

async function findFlag(
  client: TenantClient,
  member: MemberScope,
  key: string,
): Promise<Flag | null> {
  const { rows } = await client.query<FlagRow>(
    `SELECT ${FLAG_COLUMNS} FROM public.flags WHERE tenant_id = $1 AND key = $2`,
    [member.tenantId, key],
  );
  return rows[0] === undefined ? null : flagFromRow(rows[0]);
}
