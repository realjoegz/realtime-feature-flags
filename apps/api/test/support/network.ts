// A fetch between one SDK client and the API, with faults that the convergence
// simulation turns on and off. drop() breaks every open connection and refuses new
// ones until up(). A connection breaks in one of two ways: cut, as a reset
// connection, whose body fails at once; or stall, as a peer that vanished, whose
// body delivers no more bytes and never fails, so only the client's read timeout
// notices it. The API keeps writing into a stalled connection until the client
// gives up on it. aim() sends the next connections to another instance, as a load
// balancer would after the client reconnects.

export type DropMode = 'cut' | 'stall';

interface Link {
  cut(): void;
  stall(): void;
}

export class FaultyNetwork {
  readonly #links = new Set<Link>();
  #down = false;
  #origin: string | null = null;
  #lastOrigin: string | null = null;
  /** Connections that got a response. */
  opened = 0;
  /** Connections that got a response from another instance than the one before. */
  switched = 0;

  /** Every connection from now on goes to the origin of base, whatever URL the client asks for. */
  aim(base: string): void {
    this.#origin = new URL(base).origin;
  }

  /** Cuts every open connection, so the client reconnects at once. */
  cut(): void {
    for (const link of this.#links) link.cut();
  }

  get down(): boolean {
    return this.#down;
  }

  drop(mode: DropMode): void {
    this.#down = true;
    for (const link of this.#links) {
      if (mode === 'cut') link.cut();
      else link.stall();
    }
  }

  up(): void {
    this.#down = false;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.#down) throw new TypeError('fetch failed: the network is down');
    const signal = init?.signal ?? undefined;
    const upstream = new AbortController();
    let state = 'open' as 'open' | 'cut' | 'stalled';
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fail = (error: unknown): void => {
      try {
        controller?.error(error);
      } catch {
        // Already errored or closed.
      }
    };
    const link: Link = {
      cut: () => {
        state = 'cut';
        fail(new TypeError('the connection was reset'));
        upstream.abort();
      },
      stall: () => {
        if (state === 'open') state = 'stalled';
      },
    };
    const release = (): void => {
      this.#links.delete(link);
      signal?.removeEventListener('abort', onAbort);
      upstream.abort();
    };
    const onAbort = (): void => {
      fail(signal?.reason);
      release();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#links.add(link);

    let target: string | URL | Request = input;
    if (this.#origin !== null) {
      if (input instanceof Request) throw new TypeError('FaultyNetwork takes a URL, not a Request');
      const url = new URL(String(input));
      const origin = new URL(this.#origin);
      url.protocol = origin.protocol;
      url.host = origin.host;
      target = url;
    }
    let response: Response;
    try {
      response = await fetch(target, { ...init, signal: upstream.signal });
    } catch (error) {
      release();
      throw state === 'cut' ? new TypeError('the connection was reset') : error;
    }
    if (state === 'cut') {
      release();
      throw new TypeError('the connection was reset');
    }
    this.opened += 1;
    const origin = new URL(response.url || String(target)).origin;
    if (this.#lastOrigin !== null && origin !== this.#lastOrigin) this.switched += 1;
    this.#lastOrigin = origin;
    const source = response.body;
    if (source === null) {
      release();
      return response;
    }
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        async pull(c) {
          // A stalled connection delivers nothing more, and the pull never ends.
          if (state !== 'open') return new Promise<void>(() => {});
          try {
            const { done, value } = await reader.read();
            if (state !== 'open') return new Promise<void>(() => {});
            if (done) {
              c.close();
              release();
            } else {
              c.enqueue(value);
            }
          } catch (error) {
            fail(error);
            release();
          }
          return undefined;
        },
        cancel() {
          release();
        },
      },
      // Pull only when the client reads, so a stall takes effect at once.
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
