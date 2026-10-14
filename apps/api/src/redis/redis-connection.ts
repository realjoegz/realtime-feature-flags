import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createClient } from 'redis';
import { type Config, describeRedisUrl, type RedisConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

// The instance's connections to Redis. The commands connection publishes change
// notifications and reads and writes the snapshot cache; the change bus opens a
// second one, with duplicate(), for its subscription.
//
// Start-up waits for each connection until RFF_REDIS_CONNECT_DEADLINE_MS, as it
// waits for Postgres. After that a lost connection is retried without end, with
// capped backoff. While a connection is down its commands fail at once instead of
// waiting in a queue: a cache read then goes to Postgres, and a notification that
// cannot be published is logged. Correctness never depends on Redis: the safety
// poll and the read when a stream opens find every change in Postgres.

/** How long one command may wait for its reply. */
const COMMAND_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 3000;
const MAX_RETRY_DELAY_MS = 2000;

export class RedisUnreachableError extends Error {
  constructor(name: string, deadlineMs: number, cause: Error) {
    super(`Redis connection ${name} not ready within ${deadlineMs} ms: ${cause.message}`, {
      cause,
    });
    this.name = 'RedisUnreachableError';
  }
}

/** One connection's state, read by its reconnect strategy and its log lines. */
class ConnectionState {
  /** The connection has been ready at least once. */
  ready = false;
  /** It was ready, then failed, and is not ready again yet. */
  lost = false;
  /** Until the first ready: when connect() gives up. */
  deadline = Number.POSITIVE_INFINITY;

  constructor(
    readonly name: string,
    readonly deadlineMs: number,
  ) {}
}

function clientOptions(config: RedisConfig, state: ConnectionState) {
  return {
    url: config.url,
    name: state.name,
    // A command sent while the connection is down fails at once (see above).
    disableOfflineQueue: true,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number, cause: Error): number | Error => {
        if (!state.ready && performance.now() > state.deadline) {
          return new RedisUnreachableError(state.name, state.deadlineMs, cause);
        }
        return Math.min(50 * 2 ** retries, MAX_RETRY_DELAY_MS);
      },
    },
  };
}

function newClient(config: RedisConfig, state: ConnectionState) {
  return createClient(clientOptions(config, state));
}

export type RedisClient = ReturnType<typeof newClient>;

/** A client and its state, before it connects. */
export interface Connection {
  readonly client: RedisClient;
  connect(): Promise<void>;
  close(): Promise<void>;
}

@Injectable()
export class RedisConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');
  private readonly commands: Connection;
  private readonly config: RedisConfig;
  private readonly instance: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.config = config.redis;
    this.instance = config.instance;
    this.commands = this.open('commands', (state) => newClient(this.config, state));
  }

  /** The commands connection. Its commands fail at once while it is not ready. */
  get client(): RedisClient {
    return this.commands.client;
  }

  /** A second connection with the same settings, for a subscription. Not connected yet. */
  duplicate(role: string): Connection {
    const base = this.commands.client;
    return this.open(role, (state) => base.duplicate(clientOptions(this.config, state)));
  }

  async onModuleInit(): Promise<void> {
    await this.commands.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.commands.close();
  }

  private open(role: string, make: (state: ConnectionState) => RedisClient): Connection {
    // CLIENT LIST shows the name, so each connection of each instance can be told apart.
    const state = new ConnectionState(
      `${this.config.prefix}:${this.instance}:${role}`.replace(/\s/g, '_'),
      this.config.connectDeadlineMs,
    );
    const client = make(state);
    const where = describeRedisUrl(this.config.url);
    // node-redis throws an 'error' event that has no listener, which would end the
    // process. Errors are logged when the connection is first lost, not on each retry.
    client.on('error', (error: Error) => {
      if (!state.ready) {
        this.logger.warn(`${role} connection to ${where} failed: ${error.message}`);
      } else if (!state.lost) {
        state.lost = true;
        this.logger.warn(`${role} connection to ${where} lost: ${error.message}`);
      }
    });
    client.on('ready', () => {
      if (state.lost) this.logger.log(`${role} connection to ${where} ready again`);
      state.ready = true;
      state.lost = false;
    });
    return {
      client,
      connect: async () => {
        state.deadline = performance.now() + state.deadlineMs;
        await client.connect();
      },
      close: async () => {
        if (client.isOpen) await client.close();
        else client.destroy();
      },
    };
  }
}
