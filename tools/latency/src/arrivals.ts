// When each client applied each snapshot, on the clock of performance.now(). A
// change's time to the last client is measured from just before its save to the
// latest of the clients' first arrivals at its version or a later one: a client may
// skip versions, and a later snapshot holds the change as well.

interface Arrival {
  readonly version: number;
  readonly at: number;
}

interface Wait {
  readonly version: number;
  readonly resolve: () => void;
}

export class Arrivals {
  readonly #held: (number | null)[];
  #since: Arrival[][];
  #wait: Wait | null = null;

  constructor(clients: number) {
    if (!Number.isSafeInteger(clients) || clients < 1) throw new RangeError('at least one client');
    this.#held = Array.from({ length: clients }, () => null);
    this.#since = this.#held.map(() => []);
  }

  /** Client number client applied version at time at. */
  record(client: number, version: number, at: number): void {
    const arrivals = this.#since[client];
    if (arrivals === undefined) throw new RangeError(`no client ${client}`);
    this.#held[client] = version;
    arrivals.push({ version, at });
    const wait = this.#wait;
    if (wait !== null && this.allAt(wait.version)) {
      this.#wait = null;
      wait.resolve();
    }
  }

  /** Forgets the arrivals recorded so far, before the next save. */
  clear(): void {
    this.#since = this.#held.map(() => []);
  }

  /** Every client holds version or a later one. */
  allAt(version: number): boolean {
    return this.#held.every((held) => held !== null && held >= version);
  }

  /** Resolves once every client holds version or a later one; rejects after timeoutMs. */
  whenAllAt(version: number, timeoutMs: number): Promise<void> {
    if (this.allAt(version)) return Promise.resolve();
    if (this.#wait !== null) return Promise.reject(new Error('one wait at a time'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#wait = null;
        const behind = this.#held.flatMap((held, client) =>
          held !== null && held >= version ? [] : [`${client} (at ${held ?? 'none'})`],
        );
        reject(
          new Error(
            `${behind.length} clients did not reach version ${version} within ${timeoutMs} ms: ${behind.slice(0, 10).join(', ')}`,
          ),
        );
      }, timeoutMs);
      this.#wait = {
        version,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
  }

  /** Each client's first arrival at version or a later one since clear(). */
  firstArrivals(version: number): number[] {
    return this.#since.map((arrivals, client) => {
      const first = arrivals.find((arrival) => arrival.version >= version);
      if (first === undefined)
        throw new Error(`client ${client} has no arrival at ${version} or later`);
      return first.at;
    });
  }

  /** From sentAt to the last client's first arrival at version or a later one, in ms. */
  timeToLastClient(version: number, sentAt: number): number {
    return Math.max(...this.firstArrivals(version)) - sentAt;
  }
}
