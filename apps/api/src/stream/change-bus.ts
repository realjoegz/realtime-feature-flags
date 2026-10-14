import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Config } from '../config.js';
import { isUuid } from '../database/tenant-database.js';
import type { FlagsChange, FlagsNotifier } from '../flags/notifier.js';
import { type Connection, RedisConnection } from '../redis/redis-connection.js';
import { CONFIG } from '../tokens.js';
import { StreamHub } from './stream-hub.js';

// Change notifications between instances. After a flag write commits, the instance
// that wrote it publishes {tenantId, version} on <prefix>:changes. Every instance,
// the writer included, subscribes on a second connection and wakes its own streams
// of that tenant. The message only says which tenant to read; the streams get the
// snapshot that the read finds in Postgres or the cache.
//
// Pub/sub delivers a message at most once and not at all to a subscriber that is
// disconnected. So when the subscriber is ready again, which node-redis reports
// only after the subscription is renewed, every tenant with open streams on this
// instance is read again. Anything else that is lost, the safety poll finds.

/** The message on the channel, or null when it is not one. */
export function parseChange(message: string): FlagsChange | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { tenantId, version } = value as Record<string, unknown>;
  if (!isUuid(tenantId)) return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return null;
  return { tenantId, version };
}

@Injectable()
export class ChangeBus implements FlagsNotifier, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ChangeBus');
  readonly channel: string;
  private readonly subscriber: Connection;
  private subscribed = false;

  constructor(
    @Inject(CONFIG) config: Config,
    private readonly redis: RedisConnection,
    private readonly hub: StreamHub,
  ) {
    this.channel = `${config.redis.prefix}:changes`;
    this.subscriber = redis.duplicate('subscriber');
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.client.on('ready', () => {
      // The first ready comes before the subscription exists and needs no re-check.
      if (this.subscribed) this.resubscribed();
    });
    await this.subscriber.connect();
    await this.subscriber.client.subscribe(this.channel, (message) => this.received(message));
    this.subscribed = true;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.subscriber.close();
  }

  /** Publishes the change. Throws when Redis is down; the caller logs it. */
  async flagsChanged(change: FlagsChange): Promise<void> {
    const message = JSON.stringify({ tenantId: change.tenantId, version: change.version });
    await this.redis.client.publish(this.channel, message);
  }

  /** A message from the channel. */
  protected received(message: string): void {
    const change = parseChange(message);
    if (change === null) {
      this.logger.warn(`ignoring a message on ${this.channel} that is not a change`);
      return;
    }
    this.deliver(change);
  }

  /**
   * The subscriber is ready again after a lost connection, with the subscription
   * renewed: every tenant with open streams here may have missed notifications.
   */
  protected resubscribed(): void {
    this.hub.wakeAll('ready');
  }

  /** Wakes this instance's streams of the change's tenant, and of no other. */
  protected deliver(change: FlagsChange): void {
    this.hub.wake(change.tenantId, 'notification');
  }
}
