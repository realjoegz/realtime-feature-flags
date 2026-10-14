import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, Observable, ReplaySubject, takeUntil } from 'rxjs';
import { type Config } from '../config.js';
import type { Snapshot } from '../flags/flag-store.js';
import { CONFIG } from '../tokens.js';
import { SnapshotReader } from './snapshot-reader.js';

// The fan-out of GET /sdk/stream on one instance. It keeps, per tenant, the open
// streams and the last version each one was sent. A wake-up for a tenant reads the
// tenant's version, and its snapshot when a stream is behind, and sends the
// snapshot to every stream of that tenant that is behind. Four things wake a
// tenant: a stream that opens, so a client that missed versions while it was away
// gets the current snapshot at once; a change notification from Redis (ChangeBus);
// the change bus reconnecting, which wakes every tenant with open streams because
// notifications sent while it was down are lost; and the safety poll (SafetyPoll),
// which wakes every such tenant at an interval.
//
// At most one read runs per tenant. A wake-up that arrives while it runs is not
// dropped: it marks the tenant, and exactly one more read follows, however many
// wake-ups arrived. A failed read is logged; the next wake-up reads again, at the
// latest the next poll.

/** The cursor of a client that holds no version yet: any version is above it. */
export const NO_CURSOR = -1;

/** What woke a tenant: a stream opening, a notification, the bus reconnecting, the poll. */
export type WakeCause = 'connect' | 'notification' | 'ready' | 'poll';

export type Deliveries = Record<WakeCause, number>;

interface StreamClient {
  /** The version of the last snapshot sent on this connection, or its cursor. */
  lastSent: number;
  readonly send: (event: MessageEvent) => void;
}

interface TenantStreams {
  readonly clients: Set<StreamClient>;
  /** A read for the tenant is running. */
  reading: boolean;
  /** A wake-up arrived during that read. */
  again: boolean;
  /** The cause of the latest wake-up, which the next read is counted under. */
  cause: WakeCause;
}

@Injectable()
export class StreamHub implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Stream');
  private readonly tenants = new Map<string, TenantStreams>();
  /** Emits once at shutdown; a stream that opens later ends at once. */
  private readonly closing = new ReplaySubject<void>(1);
  private readonly reads = new Set<Promise<void>>();
  private closed = false;
  /**
   * Snapshot events sent, one per stream, by the cause of the wake-up whose read
   * found them. Wake-ups that arrive during one read count under the latest.
   */
  readonly delivered: Deliveries = { connect: 0, notification: 0, ready: 0, poll: 0 };

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly reader: SnapshotReader,
  ) {}

  /**
   * The events of one SDK connection to tenantId whose client holds version cursor,
   * or NO_CURSOR: the tenant's snapshot whenever the tenant is past what the
   * connection was last sent, and a heartbeat comment every interval. It completes
   * at shutdown.
   */
  stream(tenantId: string, cursor: number): Observable<MessageEvent> {
    const snapshots = new Observable<MessageEvent>((subscriber) => {
      const client: StreamClient = { lastSent: cursor, send: (event) => subscriber.next(event) };
      this.join(tenantId, client);
      this.connected(tenantId);
      return () => this.leave(tenantId, client);
    });
    const heartbeats = interval(this.config.stream.heartbeatMs).pipe(
      map((): MessageEvent => ({ comment: 'hb' })),
    );
    return merge(snapshots, heartbeats).pipe(takeUntil(this.closing));
  }

  /** tenantId may have changed: bring its open streams on this instance up to date. */
  wake(tenantId: string, cause: WakeCause): void {
    const streams = this.tenants.get(tenantId);
    if (streams === undefined || this.closed) return;
    streams.cause = cause;
    if (streams.reading) {
      streams.again = true;
      return;
    }
    streams.reading = true;
    const read = this.catchUp(tenantId, streams).finally(() => this.reads.delete(read));
    this.reads.add(read);
  }

  /** Wakes every tenant that has an open stream on this instance. */
  wakeAll(cause: WakeCause): void {
    for (const tenantId of this.tenantsWithStreams()) this.wake(tenantId, cause);
  }

  /** The tenants with at least one open stream on this instance. */
  tenantsWithStreams(): string[] {
    return [...this.tenants].flatMap(([tenantId, streams]) =>
      streams.clients.size > 0 ? [tenantId] : [],
    );
  }

  /** A stream of tenantId has opened. It gets the snapshot at once when it is behind. */
  protected connected(tenantId: string): void {
    this.wake(tenantId, 'connect');
  }

  /**
   * Completes every open stream, so that close() does not wait for clients, and
   * lets running reads finish before the pool ends.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.closed = true;
    this.closing.next();
    this.closing.complete();
    await Promise.allSettled(this.reads);
    // A completed stream ends its response a few ticks later, once Nest's piped SSE
    // stream has flushed. One turn of the event loop lets those ends reach the
    // sockets before close() destroys the connections, so clients see the stream
    // end rather than a reset.
    await new Promise((resolve) => setImmediate(resolve));
  }

  private join(tenantId: string, client: StreamClient): void {
    let streams = this.tenants.get(tenantId);
    if (streams === undefined) {
      streams = { clients: new Set(), reading: false, again: false, cause: 'connect' };
      this.tenants.set(tenantId, streams);
    }
    streams.clients.add(client);
  }

  private leave(tenantId: string, client: StreamClient): void {
    const streams = this.tenants.get(tenantId);
    if (streams === undefined) return;
    streams.clients.delete(client);
    if (streams.clients.size === 0 && !streams.reading) this.tenants.delete(tenantId);
  }

  private async catchUp(tenantId: string, streams: TenantStreams): Promise<void> {
    try {
      do {
        streams.again = false;
        const cause = streams.cause;
        const oldest = Math.min(...Array.from(streams.clients, (client) => client.lastSent));
        let read;
        try {
          // eslint-disable-next-line no-await-in-loop -- one read at a time per tenant
          read = await this.reader.read(tenantId, oldest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`reading tenant ${tenantId} for its streams failed: ${message}`);
          continue;
        }
        if (read?.snapshot) this.send(streams, read.snapshot, cause);
      } while (streams.again && streams.clients.size > 0 && !this.closed);
    } finally {
      streams.reading = false;
      if (streams.clients.size === 0 && this.tenants.get(tenantId) === streams) {
        this.tenants.delete(tenantId);
      }
    }
  }

  private send(streams: TenantStreams, snapshot: Snapshot, cause: WakeCause): void {
    // Serialized once for every stream of the tenant. The id is the version, which
    // the client sends back as Last-Event-ID when it reconnects.
    const event: MessageEvent = {
      id: String(snapshot.version),
      type: 'snapshot',
      data: JSON.stringify({
        tenantId: snapshot.tenantId,
        version: snapshot.version,
        flags: snapshot.flags,
      }),
    };
    let sent = 0;
    for (const client of streams.clients) {
      if (client.lastSent < snapshot.version) {
        client.lastSent = snapshot.version;
        client.send(event);
        sent += 1;
      }
    }
    this.delivered[cause] += sent;
    // What a read sends is logged, with its cause, unless the latest wake-up that
    // asked for the read was a notification. tools/latency counts these lines in
    // the replicas' logs to report the deliveries during a run that came from a
    // connection, the bus reconnecting or the poll. Notification deliveries, one
    // per change, are not logged.
    if (sent > 0 && cause !== 'notification') {
      this.logger.log(
        `sent version ${snapshot.version} of tenant ${snapshot.tenantId} to ${sent} ${sent === 1 ? 'stream' : 'streams'} after a ${cause} wake-up`,
      );
    }
  }
}
