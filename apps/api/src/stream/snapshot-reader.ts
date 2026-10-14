import { Injectable } from '@nestjs/common';
import { TenantDatabase } from '../database/tenant-database.js';
import { readSnapshot, readVersion, type Snapshot } from '../flags/flag-store.js';

export interface TenantRead {
  readonly version: number;
  /** The snapshot when the version was above the one asked about, else null. */
  readonly snapshot: Snapshot | null;
}

/**
 * How the stream fan-out reads a tenant. Each read is one short withTenant
 * transaction with no user, so no pooled connection is held between reads or for
 * the life of a stream.
 */
@Injectable()
export class SnapshotReader {
  constructor(protected readonly db: TenantDatabase) {}

  /**
   * The tenant's version, and its snapshot when the version is above `above`. Null
   * when the tenant does not exist.
   */
  async read(tenantId: string, above: number): Promise<TenantRead | null> {
    return this.db.withTenant({ tenantId, userId: null }, async (client) => {
      const version = await readVersion(client, tenantId);
      if (version === null) return null;
      if (version <= above) return { version, snapshot: null };
      // A write can commit between the two statements, so the snapshot's version can
      // be higher than the one just read. The snapshot is one statement and carries
      // its own version, so its flags are always those of its version.
      const snapshot = await readSnapshot(client, tenantId);
      return snapshot === null ? null : { version: snapshot.version, snapshot };
    });
  }
}
