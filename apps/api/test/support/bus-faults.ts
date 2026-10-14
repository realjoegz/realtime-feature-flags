import type { TestingModuleBuilder } from '@nestjs/testing';
import { type Config } from '../../src/config.js';
import type { FlagsChange } from '../../src/flags/notifier.js';
import { RedisConnection } from '../../src/redis/redis-connection.js';
import { ChangeBus } from '../../src/stream/change-bus.js';
import { StreamHub } from '../../src/stream/stream-hub.js';
import { CONFIG } from '../../src/tokens.js';
import type { Redis } from '../harness/redis.js';

// Faults in the change notifications between instances, which the tests turn on
// and off: a notification that one instance's subscriber never hears, every
// notification lost, and a publish that throws. One BusFaults is shared by the
// apps of an environment; each app's FaultyBus knows its own index.

export class BusFaults {
  /** Every notification is lost, at every instance. */
  dropAll = false;
  /** Notifications lost, by the instance whose subscriber missed them. */
  readonly dropped: number[] = [];
  /** Publishes that threw. */
  thrown = 0;
  readonly #dropNext = new Map<number, number>();
  #failPublishes = 0;

  /** The next notification that reaches instance is lost there. */
  dropNextAt(instance: number): void {
    this.#dropNext.set(instance, (this.#dropNext.get(instance) ?? 0) + 1);
  }

  /** The next publish, from any instance, throws. */
  failNextPublish(): void {
    this.#failPublishes += 1;
  }

  /** Ends the faults that steps asked for; dropAll stays as it is. */
  clear(): void {
    this.#dropNext.clear();
    this.#failPublishes = 0;
  }

  takeDrop(instance: number): boolean {
    const pending = this.#dropNext.get(instance) ?? 0;
    if (!this.dropAll && pending === 0) return false;
    if (pending > 0) this.#dropNext.set(instance, pending - 1);
    this.dropped[instance] = (this.dropped[instance] ?? 0) + 1;
    return true;
  }

  takePublishFailure(): boolean {
    if (this.#failPublishes === 0) return false;
    this.#failPublishes -= 1;
    this.thrown += 1;
    return true;
  }
}

export class FaultyBus extends ChangeBus {
  constructor(
    config: Config,
    redis: RedisConnection,
    hub: StreamHub,
    private readonly faults: BusFaults,
    private readonly index: number,
    private readonly recheckOnReady = true,
  ) {
    super(config, redis, hub);
  }

  override async flagsChanged(change: FlagsChange): Promise<void> {
    if (this.faults.takePublishFailure()) throw new Error('the publisher is down');
    await super.flagsChanged(change);
  }

  protected override deliver(change: FlagsChange): void {
    if (this.faults.takeDrop(this.index)) return;
    super.deliver(change);
  }

  protected override resubscribed(): void {
    if (this.recheckOnReady) super.resubscribed();
  }
}

export interface FaultyBusOptions {
  /** False makes a broken bus that reads nothing again after its subscriber reconnects. */
  readonly recheckOnReady?: boolean;
}

/** Replaces app index's change bus with one that obeys faults. */
export function withFaultyBus(
  builder: TestingModuleBuilder,
  faults: BusFaults,
  index: number,
  options: FaultyBusOptions = {},
): TestingModuleBuilder {
  return builder.overrideProvider(ChangeBus).useFactory({
    factory: (config: Config, redis: RedisConnection, hub: StreamHub) =>
      new FaultyBus(config, redis, hub, faults, index, options.recheckOnReady ?? true),
    inject: [CONFIG, RedisConnection, StreamHub],
  });
}

/**
 * Closes the Redis connection called name from the server side, as a network fault
 * or a Redis restart would. node-redis then reconnects it. Returns how many
 * connections had that name.
 */
export async function killConnection(redis: Redis, name: string): Promise<number> {
  const list = String(await redis.sendCommand(['CLIENT', 'LIST']));
  const ids = list
    .split('\n')
    .filter((line) => line.split(' ').includes(`name=${name}`))
    .map((line) => /(?:^| )id=(\d+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- one connection after another
    await redis.sendCommand(['CLIENT', 'KILL', 'ID', id]);
  }
  return ids.length;
}

/** The name of the subscriber connection of the app with this instance name. */
export function subscriberName(redisPrefix: string, instance: string): string {
  return `${redisPrefix}:${instance}:subscriber`;
}
