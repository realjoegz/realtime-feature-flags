// A fetch for the client tests: each call is a connection that the test drives,
// sending bytes, ending or failing the body, or answering with a status or a
// network error instead. Aborting the request's signal errors the body with the
// signal's reason, as fetch does.

import type { FlagsSnapshot } from '../../src/index.ts';

const encoder = new TextEncoder();

export interface FakeConnection {
  readonly url: string;
  readonly headers: Headers;
  /** performance.now() when the client made the request. */
  readonly at: number;
  send(bytes: string | Uint8Array): void;
  end(): void;
  fail(error: Error): void;
  readonly isAborted: boolean;
  /** Resolves with performance.now() when the client aborts the connection. */
  readonly aborted: Promise<number>;
}

/** How the next request is answered, instead of a stream the test drives. */
export type Answer = { readonly status: number } | { readonly networkError: Error };

export class FakeStreamServer {
  readonly connections: FakeConnection[] = [];
  /** Every request, including the ones answered with a status or a network error. */
  readonly requests: { readonly headers: Headers; readonly at: number }[] = [];
  readonly #answers: Answer[] = [];
  readonly #waiting: ((connection: FakeConnection) => void)[] = [];

  /** Answers the next requests in order, before any further one gets a stream. */
  answer(...answers: Answer[]): void {
    this.#answers.push(...answers);
  }

  /** The connection with this index, once the client has made it. */
  connection(index: number): Promise<FakeConnection> {
    const made = this.connections[index];
    if (made !== undefined) return Promise.resolve(made);
    return new Promise((resolve) => {
      const check = (): void => {
        const connection = this.connections[index];
        if (connection === undefined) this.#waiting.push(check);
        else resolve(connection);
      };
      this.#waiting.push(check);
    });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const at = performance.now();
    this.requests.push({ headers, at });
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const planned = this.#answers.shift();
    if (planned !== undefined) {
      if ('networkError' in planned) throw planned.networkError;
      return new Response(`{"statusCode":${planned.status}}`, {
        status: planned.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    let isAborted = false;
    let onAbort!: (at: number) => void;
    const aborted = new Promise<number>((resolve) => (onAbort = resolve));
    signal?.addEventListener(
      'abort',
      () => {
        isAborted = true;
        onAbort(performance.now());
        try {
          controller.error(signal.reason);
        } catch {
          // Already closed.
        }
      },
      { once: true },
    );
    const connection: FakeConnection = {
      url: String(input),
      headers,
      at,
      send(bytes) {
        try {
          controller.enqueue(typeof bytes === 'string' ? encoder.encode(bytes) : bytes);
        } catch {
          // The body is closed: the client has gone.
        }
      },
      end() {
        try {
          controller.close();
        } catch {
          // Already closed or errored.
        }
      },
      fail(error) {
        try {
          controller.error(error);
        } catch {
          // Already closed or errored.
        }
      },
      get isAborted() {
        return isAborted;
      },
      aborted,
    };
    this.connections.push(connection);
    for (const wake of this.#waiting.splice(0)) wake(connection);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

/** A snapshot event as Nest writes it: event, id, then the data line. */
export function snapshotFrame(snapshot: FlagsSnapshot, id = String(snapshot.version)): string {
  return `event: snapshot\nid: ${id}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export const TENANT = '6f1d6a52-0d6c-4d8e-9a39-3c1f2b7e4a10';

/** A snapshot with one flag whose rollout records the version, to tell snapshots apart. */
export function snapshotAt(version: number, tenantId = TENANT): FlagsSnapshot {
  return {
    tenantId,
    version,
    flags: [
      {
        key: 'marker',
        enabled: true,
        salt: '0123456789abcdef',
        rules: [],
        rolloutBasisPoints: version % 10_001,
      },
    ],
  };
}

/** Resolves once the condition holds, checking every 5 ms, or rejects after timeoutMs. */
export async function until(
  condition: () => boolean,
  timeoutMs = 5000,
  what = 'the condition',
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
