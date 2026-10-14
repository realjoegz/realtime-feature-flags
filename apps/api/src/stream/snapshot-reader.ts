import { Injectable } from '@nestjs/common';
import { TenantDatabase, type TenantScope } from '../database/tenant-database.js';
import { FlagsCache } from '../flags/flags-cache.js';
import { readSnapshot, readVersion, type Snapshot } from '../flags/flag-store.js';

export interface TenantRead {
  readonly version: number;
  /** The snapshot when the version was above the one asked about, else null. */
  readonly snapshot: Snapshot | null;
}

/** Below every version, so that a read for it always returns the snapshot. */
const ANY_VERSION = -1;

/**
 * How the stream fan-out and the flag routes read a tenant's snapshot. The current
 * version comes from Postgres, in a short withTenant transaction; then the cache
 * entry of that version; else the snapshot from Postgres in one statement, which
 * then goes into the cache when its version is still the one read first. A read
 * that starts after a write has committed therefore returns that write's version or
 * a later one, with the cache warm or cold. No pooled connection is held while
 * Redis answers, between reads, or for the life of a stream.
 */
@Injectable()
export class SnapshotReader {
  constructor(
    protected readonly db: TenantDatabase,
    protected readonly cache: FlagsCache,
  ) {}

  /**
   * For the stream: the tenant's version, and its snapshot when the version is above
   * `above`. Null when the tenant does not exist.
   */
  async read(tenantId: string, above: number): Promise<TenantRead | null> {
    return this.readAbove({ tenantId, userId: null }, above);
  }

  /** For the routes: the tenant's current snapshot, read in scope. Null when there is no tenant. */
  async current(scope: TenantScope): Promise<Snapshot | null> {
    return (await this.readAbove(scope, ANY_VERSION))?.snapshot ?? null;
  }

  private async readAbove(scope: TenantScope, above: number): Promise<TenantRead | null> {
    const { tenantId } = scope;
    const version = await this.db.withTenant(scope, (client) => readVersion(client, tenantId));
    if (version === null) return null;
    if (version <= above) return { version, snapshot: null };
    const cached = await this.cache.get(tenantId, version);
    if (cached !== null) return { version, snapshot: cached };
    // A write can commit between the two reads, so the snapshot's version can be
    // higher than the one just read. The snapshot is one statement and carries its
    // own version, so its flags are always those of its version. It goes into the
    // cache only when it is of the version read first.
    const snapshot = await this.db.withTenant(scope, (client) => readSnapshot(client, tenantId));
    if (snapshot === null) return null;
    if (snapshot.version === version) await this.cache.put(snapshot);
    return { version: snapshot.version, snapshot };
  }
}
