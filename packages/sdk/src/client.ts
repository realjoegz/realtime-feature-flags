import { type Context, type Evaluation, evaluate, type Flag } from '@rff/core';
import { DEFAULT_RECONNECT, reconnectDelay, type ReconnectOptions } from './backoff.ts';
import { type FlagsSnapshot, parseSnapshot, SnapshotError } from './snapshot.ts';
import { type SseEvent, SseParser } from './sse-parser.ts';

// The client keeps one connection to GET /sdk/stream and holds the latest snapshot
// it received. Each snapshot event carries all flags of the tenant at one version,
// so a client that missed versions needs only the next one. On reconnect it sends
// the version it holds as Last-Event-ID, and the server sends a snapshot only when
// the tenant has a newer one. The client applies a snapshot only when its version
// is greater than the one it holds, so its version never goes back, although it can
// skip versions.
//
// A connection that delivers no bytes for three heartbeat intervals is taken for
// dead, as a connection whose peer vanished never reports an error, and is replaced.
// Reconnects wait with capped exponential backoff and jitter (backoff.ts).

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/** No bytes for this many heartbeat intervals means the connection is dead. */
export const READ_TIMEOUT_INTERVALS = 3;

/** Statuses that a retry cannot change: the key is wrong or revoked, or the request is. */
const FATAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

export interface FlagsClientOptions {
  /** The API's base URL. The client connects to <url>/sdk/stream. */
  readonly url: string;
  /** The tenant's SDK key, rff_sdk_ and 43 base64url characters. */
  readonly sdkKey: string;
  /** The server's heartbeat interval. Default 15000 ms, the server's default. */
  readonly heartbeatIntervalMs?: number;
  readonly reconnect?: ReconnectOptions;
  /** The fetch to connect with. Default globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** A number in [0, 1) for the backoff jitter. Default Math.random. */
  readonly random?: () => number;
  /** Called with every failure: a refused or lost connection, a read timeout, an invalid snapshot, a listener that threw. */
  readonly onError?: (error: Error) => void;
}

/** The stream answered with another status than 200. */
export class StreamStatusError extends Error {
  readonly status: number;
  /** The client stops after this status instead of reconnecting. */
  readonly fatal: boolean;

  constructor(status: number) {
    super(`the stream answered ${status}`);
    this.name = 'StreamStatusError';
    this.status = status;
    this.fatal = FATAL_STATUSES.has(status);
  }
}

/** The connection delivered no bytes for three heartbeat intervals. */
export class ReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no bytes for ${timeoutMs} ms`);
    this.name = 'ReadTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export type ChangeListener = (snapshot: FlagsSnapshot) => void;

export class FlagsClient {
  readonly #streamUrl: string;
  readonly #sdkKey: string;
  readonly #heartbeatMs: number;
  readonly #reconnect: Required<ReconnectOptions>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #random: () => number;
  readonly #onError: (error: Error) => void;
  readonly #listeners = new Set<ChangeListener>();
  readonly #loop: Promise<void>;
  #snapshot: FlagsSnapshot | null = null;
  #byKey = new Map<string, Flag>();
  #closed = false;
  #connection: AbortController | null = null;
  #endWait: (() => void) | null = null;

  /** Starts connecting at once. */
  constructor(options: FlagsClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('url must be an http or https URL');
    }
    if (typeof options.sdkKey !== 'string' || options.sdkKey === '') {
      throw new TypeError('sdkKey is required');
    }
    const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0) {
      throw new TypeError('heartbeatIntervalMs must be a positive integer');
    }
    const reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
    if (!(reconnect.initialMs > 0) || !(reconnect.maxMs >= reconnect.initialMs)) {
      throw new TypeError('reconnect needs 0 < initialMs <= maxMs');
    }
    this.#streamUrl = `${options.url.replace(/\/+$/, '')}/sdk/stream`;
    this.#sdkKey = options.sdkKey;
    this.#heartbeatMs = heartbeatMs;
    this.#reconnect = reconnect;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#random = options.random ?? Math.random;
    this.#onError = options.onError ?? (() => {});
    this.#loop = this.#run();
  }

  /** The version of the snapshot the client holds, or null before the first one. */
  get version(): number | null {
    return this.#snapshot?.version ?? null;
  }

  /** The flags of the snapshot the client holds, ordered by key; empty before the first one. */
  get flags(): readonly Flag[] {
    return this.#snapshot?.flags ?? [];
  }

  /** The flag evaluated for context with @rff/core, or undefined when the client holds no such flag. */
  evaluate(flagKey: string, context: Context): Evaluation | undefined {
    const flag = this.#byKey.get(flagKey);
    return flag === undefined ? undefined : evaluate(flag, context);
  }

  /** Calls listener after each snapshot the client applies. Returns a function that removes it. */
  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Closes the connection and stops reconnecting. Resolves once the client has stopped. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#connection?.abort();
    this.#endWait?.();
    await this.#loop;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#closed) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one connection at a time
        await this.#connect(() => {
          failures = 0;
        });
        // The server ended the stream, as it does when it shuts down: reconnect.
      } catch (error) {
        if (this.#closed) return;
        const failure = asError(error);
        this.#report(failure);
        if (failure instanceof StreamStatusError && failure.fatal) {
          this.#closed = true;
          return;
        }
      }
      if (this.#closed) return;
      const delay = reconnectDelay(failures, this.#reconnect, this.#random);
      failures += 1;
      // eslint-disable-next-line no-await-in-loop -- the backoff between connections
      await this.#wait(delay);
    }
  }

  async #connect(onOpen: () => void): Promise<void> {
    const connection = new AbortController();
    this.#connection = connection;
    const timeoutMs = this.#heartbeatMs * READ_TIMEOUT_INTERVALS;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    // The watchdog also covers the wait for the response headers.
    const rearm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => connection.abort(new ReadTimeoutError(timeoutMs)), timeoutMs);
    };
    rearm();
    try {
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        authorization: `Bearer ${this.#sdkKey}`,
      };
      if (this.#snapshot !== null) headers['last-event-id'] = String(this.#snapshot.version);
      const response = await this.#fetch(this.#streamUrl, { headers, signal: connection.signal });
      const type = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !type.startsWith('text/event-stream') || !response.body) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 200) throw new StreamStatusError(response.status);
        throw new Error(`the stream answered with content type "${type}"`);
      }
      onOpen();
      const parser = new SseParser((event) => this.#receive(event));
      const reader = response.body.getReader();
      while (!this.#closed) {
        // eslint-disable-next-line no-await-in-loop -- chunks arrive one after another
        const { done, value } = await reader.read();
        if (done) return;
        rearm();
        parser.push(value);
      }
    } catch (error) {
      // A read that the watchdog aborted rejects with an AbortError; report the timeout.
      const reason: unknown = connection.signal.reason;
      if (reason instanceof ReadTimeoutError) throw reason;
      throw error;
    } finally {
      clearTimeout(watchdog);
      // Releases the connection when the loop ended without an error.
      connection.abort();
      if (this.#connection === connection) this.#connection = null;
    }
  }

  #receive(event: SseEvent): void {
    if (this.#closed || event.type !== 'snapshot') return;
    let snapshot: FlagsSnapshot;
    try {
      snapshot = parseSnapshot(event.data);
    } catch (error) {
      this.#report(asError(error));
      return;
    }
    if (event.lastEventId !== String(snapshot.version)) {
      this.#report(
        new SnapshotError(
          `event id ${JSON.stringify(event.lastEventId)} is not the snapshot version ${snapshot.version}`,
        ),
      );
      return;
    }
    const held = this.#snapshot;
    if (held !== null && snapshot.tenantId !== held.tenantId) {
      this.#report(new SnapshotError(`a snapshot of tenant ${snapshot.tenantId} arrived`));
      return;
    }
    // The version rule: never apply a snapshot that is not newer than the one held.
    if (held !== null && snapshot.version <= held.version) return;
    this.#snapshot = snapshot;
    this.#byKey = new Map(snapshot.flags.map((flag) => [flag.key, flag]));
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#report(asError(error));
      }
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const end = (): void => {
        clearTimeout(timer);
        this.#endWait = null;
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.#endWait = end;
    });
  }

  #report(error: Error): void {
    try {
      this.#onError(error);
    } catch {
      // An onError that throws must not stop the client.
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
