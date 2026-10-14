import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Config } from '../config.js';
import { RedisConnection } from '../redis/redis-connection.js';
import { CONFIG } from '../tokens.js';
import type { Snapshot } from './flag-store.js';

// Snapshots in Redis, one key per tenant and version: <prefix>:flags:<tenantId>:v<n>.
// An entry is written only from a snapshot read in one statement, so it holds
// exactly the flags of its version, and a version never changes once written. A
// read therefore takes the tenant's current version from Postgres first and only
// then asks for the entry of that version (SnapshotReader.readAbove): an entry can
// be missing, but never stale. A flag write deletes the entry of the version before
// it; the one-hour expiry removes any entry that a read wrote after that delete.
//
// Every failure counts as a miss and goes to Postgres, and a write that fails is
// logged. While the connection is down the cache is skipped without a log line for
// each request; the connection logs the outage once.

export const CACHE_TTL_SECONDS = 3600;

@Injectable()
export class FlagsCache {
  private readonly logger = new Logger('FlagsCache');
  protected readonly prefix: string;
  /** Reads answered from Redis. */
  hits = 0;
  /** Reads that found no usable entry, Redis being down included. */
  misses = 0;

  constructor(
    @Inject(CONFIG) config: Config,
    protected readonly redis: RedisConnection,
  ) {
    this.prefix = config.redis.prefix;
  }

  key(tenantId: string, version: number): string {
    return `${this.prefix}:flags:${tenantId}:v${version}`;
  }

  /** The snapshot of tenantId at version, or null when Redis has no usable entry. */
  async get(tenantId: string, version: number): Promise<Snapshot | null> {
    const client = this.redis.client;
    let text: string | null = null;
    if (client.isReady) {
      try {
        text = await client.get(this.key(tenantId, version));
      } catch (error) {
        this.warn(`reading ${this.key(tenantId, version)}`, error);
      }
    }
    const snapshot = text === null ? null : this.entry(text, tenantId, version);
    if (snapshot === null) this.misses += 1;
    else this.hits += 1;
    return snapshot;
  }

  async put(snapshot: Snapshot): Promise<void> {
    const client = this.redis.client;
    if (!client.isReady) return;
    const key = this.key(snapshot.tenantId, snapshot.version);
    const text = JSON.stringify({
      tenantId: snapshot.tenantId,
      version: snapshot.version,
      flags: snapshot.flags,
    });
    try {
      await client.set(key, text, { expiration: { type: 'EX', value: CACHE_TTL_SECONDS } });
    } catch (error) {
      this.warn(`writing ${key}`, error);
    }
  }

  /** Deletes the entry of tenantId at version, if there is one. */
  async forget(tenantId: string, version: number): Promise<void> {
    const client = this.redis.client;
    if (!client.isReady) return;
    try {
      await client.del(this.key(tenantId, version));
    } catch (error) {
      this.warn(`deleting ${this.key(tenantId, version)}`, error);
    }
  }

  /**
   * The snapshot in an entry, used only when it names the tenant and the version it
   * was asked for; anything else is logged and read from Postgres instead.
   */
  protected entry(text: string, tenantId: string, version: number): Snapshot | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const entry = value as Partial<Snapshot> | null;
    if (
      entry !== null &&
      typeof entry === 'object' &&
      entry.tenantId === tenantId &&
      entry.version === version &&
      Array.isArray(entry.flags)
    ) {
      return { tenantId, version, flags: entry.flags };
    }
    this.logger.warn(`ignoring ${this.key(tenantId, version)}: not the snapshot of that key`);
    return null;
  }

  private warn(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`${what} failed: ${message}`);
  }
}
