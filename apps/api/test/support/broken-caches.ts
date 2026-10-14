import type { TestingModuleBuilder } from '@nestjs/testing';
import { type Config } from '../../src/config.js';
import type { Snapshot } from '../../src/flags/flag-store.js';
import { FlagsCache } from '../../src/flags/flags-cache.js';
import { RedisConnection } from '../../src/redis/redis-connection.js';
import { CONFIG } from '../../src/tokens.js';

// Caches with one defect each, for the controls of the cache, isolation and
// agreement tests. Each replaces FlagsCache in the app it is given to.

/**
 * A stale cache: one entry per tenant, the first one stored, which answers every
 * version asked for and which no change removes.
 */
export class FirstEntryCache extends FlagsCache {
  override async get(tenantId: string, version: number): Promise<Snapshot | null> {
    const text = await this.redis.client.get(this.entryKey(tenantId));
    if (text === null) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    const entry = JSON.parse(text) as Snapshot;
    return { tenantId: entry.tenantId, version, flags: entry.flags };
  }

  override async put(snapshot: Snapshot): Promise<void> {
    await this.redis.client.set(this.entryKey(snapshot.tenantId), JSON.stringify(snapshot), {
      condition: 'NX',
    });
  }

  override async forget(): Promise<void> {}

  private entryKey(tenantId: string): string {
    return `${this.prefix}:flags:${tenantId}:first`;
  }
}

/** A cache whose key leaves out the tenant: tenants at one version share an entry. */
export class TenantlessKeyCache extends FlagsCache {
  override key(_tenantId: string, version: number): string {
    return `${this.prefix}:flags:v${version}`;
  }
}

/** A tenant-less key, and entries used without checking the tenant they name. */
export class UncheckedTenantlessCache extends TenantlessKeyCache {
  protected override entry(text: string): Snapshot | null {
    return JSON.parse(text) as Snapshot;
  }
}

export type CacheClass = new (config: Config, redis: RedisConnection) => FlagsCache;

export function withCache(builder: TestingModuleBuilder, cache: CacheClass): TestingModuleBuilder {
  return builder.overrideProvider(FlagsCache).useFactory({
    factory: (config: Config, redis: RedisConnection) => new cache(config, redis),
    inject: [CONFIG, RedisConnection],
  });
}
