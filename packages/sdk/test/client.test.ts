import { readFileSync } from 'node:fs';
import type { Context, Evaluation, Flag } from '@rff/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONNECT,
  FlagsClient,
  type FlagsClientOptions,
  type FlagsSnapshot,
  ReadTimeoutError,
  reconnectDelay,
  SnapshotError,
  StreamStatusError,
} from '../src/index.ts';
import {
  FakeStreamServer,
  snapshotAt,
  snapshotFrame,
  TENANT,
  until,
} from './support/fake-stream.ts';
import { label, runParams } from './support/fc-params.ts';

const SDK_KEY = `rff_sdk_${'A'.repeat(43)}`;

const clients: FlagsClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

interface Recorded {
  readonly client: FlagsClient;
  readonly applied: FlagsSnapshot[];
  readonly errors: Error[];
}

function start(server: FakeStreamServer, options: Partial<FlagsClientOptions> = {}): Recorded {
  const errors: Error[] = [];
  const client = new FlagsClient({
    url: 'http://flags.example.test/',
    sdkKey: SDK_KEY,
    fetch: server.fetch,
    reconnect: { initialMs: 5, maxMs: 20 },
    onError: (error) => errors.push(error),
    ...options,
  });
  clients.push(client);
  const applied: FlagsSnapshot[] = [];
  client.onChange((snapshot) => applied.push(snapshot));
  return { client, applied, errors };
}

const VERSION_RULE = runParams(200);

describe('SDK client', () => {
  it(`applies a snapshot only when its version is greater than the one it holds, over reconnects too, and calls onChange once for each one it applies ${label(VERSION_RULE)}`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.nat(30), { maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        async (connections) => {
          const server = new FakeStreamServer();
          const { client, applied } = start(server);
          for (const [index, versions] of connections.entries()) {
            // eslint-disable-next-line no-await-in-loop -- one connection after another
            const connection = await server.connection(index);
            for (const version of versions) connection.send(snapshotFrame(snapshotAt(version)));
            if (index < connections.length - 1) connection.end();
          }
          // A last, higher version shows that every byte before it was read.
          const last = await server.connection(connections.length - 1);
          last.send(snapshotFrame(snapshotAt(1000)));
          await until(() => client.version === 1000, 5000, 'version 1000');

          const expected: number[] = [];
          for (const version of connections.flat()) {
            if (expected.length === 0 || version > (expected.at(-1) as number)) {
              expected.push(version);
            }
          }
          expect(applied.map((snapshot) => snapshot.version)).toEqual([...expected, 1000]);
          // Each applied snapshot is the one sent with its version.
          for (const snapshot of applied) expect(snapshot).toEqual(snapshotAt(snapshot.version));
          expect(client.flags).toEqual(snapshotAt(1000).flags);
          await client.close();
        },
      ),
      { seed: VERSION_RULE.seed, numRuns: VERSION_RULE.numRuns },
    );
  });

  it('applies no invalid snapshot and reports each: not JSON, a flag that validateFlag refuses, a duplicate key, an id other than the version, another tenant', async () => {
    const server = new FakeStreamServer();
    const { client, applied, errors } = start(server);
    const connection = await server.connection(0);
    connection.send(snapshotFrame(snapshotAt(1)));
    const flag = snapshotAt(1).flags[0] as Flag;
    connection.send('event: snapshot\nid: 5\ndata: {"tenantId":\n\n');
    connection.send(
      snapshotFrame({ tenantId: TENANT, version: 6, flags: [{ ...flag, salt: 'not-hex' }] }),
    );
    connection.send(snapshotFrame({ tenantId: TENANT, version: 7, flags: [flag, flag] }));
    connection.send(snapshotFrame(snapshotAt(8), '9'));
    connection.send(snapshotFrame(snapshotAt(10, '0d9a1c52-3f0e-4c4b-8a77-5d2a9e6b1c20')));
    // Events of another type are not snapshots and are passed over.
    connection.send('event: message\nid: 11\ndata: {}\n\n');
    connection.send(snapshotFrame(snapshotAt(2)));
    await until(() => client.version === 2, 5000, 'version 2');
    expect(applied.map((snapshot) => snapshot.version)).toEqual([1, 2]);
    expect(errors.map((error) => [error.name, error.message])).toEqual([
      ['SnapshotError', 'the snapshot is not JSON'],
      ['SnapshotError', expect.stringMatching(/^flag 0 is invalid: salt: /)],
      ['SnapshotError', 'flag key marker appears twice'],
      ['SnapshotError', 'event id "9" is not the snapshot version 8'],
      ['SnapshotError', 'a snapshot of tenant 0d9a1c52-3f0e-4c4b-8a77-5d2a9e6b1c20 arrived'],
    ]);
    expect(errors.every((error) => error instanceof SnapshotError)).toBe(true);
  });

  it('sends no Last-Event-ID on its first connection and the version it holds on each reconnect, after the server ends the stream and after the connection fails', async () => {
    const server = new FakeStreamServer();
    const { client, errors } = start(server);
    const first = await server.connection(0);
    expect(first.url).toBe('http://flags.example.test/sdk/stream');
    expect(first.headers.get('authorization')).toBe(`Bearer ${SDK_KEY}`);
    expect(first.headers.get('accept')).toBe('text/event-stream');
    expect(first.headers.has('last-event-id')).toBe(false);
    first.send(snapshotFrame(snapshotAt(4)));
    await until(() => client.version === 4);
    // Events the client does not apply carry other ids: a refused snapshot with a
    // higher version, an event of another type and an older snapshot. The client
    // still holds 4, and 4 is what it sends.
    const flag = snapshotAt(9).flags[0] as Flag;
    first.send(snapshotFrame({ tenantId: TENANT, version: 9, flags: [{ ...flag, salt: 'bad' }] }));
    first.send('event: message\nid: 11\ndata: {}\n\n');
    first.send(snapshotFrame(snapshotAt(2)));
    first.send(snapshotFrame(snapshotAt(5), '6'));
    await until(() => errors.length === 2, 5000, 'two refused snapshots');
    expect(client.version).toBe(4);
    first.end();
    const second = await server.connection(1);
    expect(second.headers.get('last-event-id')).toBe('4');
    second.send(snapshotFrame(snapshotAt(7)));
    await until(() => client.version === 7);
    second.fail(new TypeError('connection reset'));
    const third = await server.connection(2);
    expect(third.headers.get('last-event-id')).toBe('7');
  });

  it('a connection that delivers no bytes for three heartbeat intervals is aborted and replaced, while heartbeats alone keep a connection open', async () => {
    const server = new FakeStreamServer();
    const heartbeatIntervalMs = 100;
    const { client, errors } = start(server, { heartbeatIntervalMs });
    const first = await server.connection(0);
    first.send('\n');
    first.send(snapshotFrame(snapshotAt(1)));
    // Heartbeats every 50 ms for 700 ms, more than twice the read timeout of 300 ms.
    let lastByte = performance.now();
    const beats = setInterval(() => {
      first.send(': hb\n\n');
      lastByte = performance.now();
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 700));
    clearInterval(beats);
    expect(first.isAborted).toBe(false);
    expect(server.connections).toHaveLength(1);

    const abortedAt = await first.aborted;
    expect(abortedAt - lastByte).toBeGreaterThanOrEqual(3 * heartbeatIntervalMs - 5);
    const second = await server.connection(1);
    expect(second.headers.get('last-event-id')).toBe('1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ReadTimeoutError);
    expect(errors[0]?.message).toBe('no bytes for 300 ms');
    expect(client.version).toBe(1);
  });

  it('reconnects with capped exponential backoff and jitter after refused connections and 503, and resets the backoff once a connection opens', async () => {
    const server = new FakeStreamServer();
    const refused = { networkError: new TypeError('fetch failed') };
    server.answer(refused, refused, { status: 503 }, refused, refused);
    // The ceilings are 40, 80, 160 and 320, then 320 again where an uncapped one
    // would be 640. Each wait is half the ceiling plus the random draw times the
    // other half: 39, 40, 120, 160 and 160. Without the jitter the first and third
    // would be 20 and 80.
    const draws = [0.95, 0, 0.5, 0, 0];
    const { client, errors } = start(server, {
      reconnect: { initialMs: 40, maxMs: 320 },
      random: () => draws.shift() ?? 0,
    });
    const opened = await server.connection(0);
    opened.send(snapshotFrame(snapshotAt(3)));
    await until(() => client.version === 3);
    const gaps = server.requests.slice(1).map((request, index) => {
      const previous = server.requests[index] as { at: number };
      return request.at - previous.at;
    });
    expect(gaps).toHaveLength(5);
    expect(draws).toEqual([]);
    [39, 40, 120, 160, 160].forEach((wait, index) => {
      expect(gaps[index], `wait ${index}`).toBeGreaterThanOrEqual(wait - 2);
    });
    expect(gaps[4], 'the capped wait').toBeLessThan(300);
    expect(errors.map((error) => error.message)).toEqual([
      'fetch failed',
      'fetch failed',
      'the stream answered 503',
      'fetch failed',
      'fetch failed',
    ]);
    // The connection opened, so the next wait is 20 ms again, not 160.
    const endedAt = performance.now();
    opened.end();
    await server.connection(1);
    expect(performance.now() - endedAt).toBeLessThan(120);
  });

  it(`the wait before reconnect attempt n is c * (1 + r) / 2 for the ceiling c = min(maxMs, initialMs * 2^n) and the random draw r, between half and all of c ${label(VERSION_RULE)}`, () => {
    fc.assert(
      fc.property(
        fc.nat(80),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 100 }),
        (failures, jitter, initialMs, factor) => {
          const options = { initialMs, maxMs: initialMs * factor };
          const ceiling = Math.min(options.maxMs, initialMs * 2 ** failures);
          const delay = reconnectDelay(failures, options, () => jitter);
          // The draw decides where in the upper half of the ceiling the wait falls,
          // so clients that lost the same server spread out.
          expect(delay).toBeCloseTo((ceiling * (1 + jitter)) / 2, 6);
          expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
          expect(delay).toBeLessThanOrEqual(ceiling);
          expect(reconnectDelay(failures + 1, options, () => jitter)).toBeGreaterThanOrEqual(delay);
        },
      ),
      { seed: VERSION_RULE.seed, numRuns: VERSION_RULE.numRuns },
    );
    expect(DEFAULT_RECONNECT).toEqual({ initialMs: 1000, maxMs: 30_000 });
  });

  it('stops after 401, which a retry cannot change, and reports it', async () => {
    const server = new FakeStreamServer();
    server.answer({ status: 401 });
    const { errors } = start(server);
    await until(() => errors.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.requests).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StreamStatusError);
    expect(errors[0]).toMatchObject({ status: 401, fatal: true });
  });

  it('close() aborts the connection and stops reconnecting, and no listener runs afterwards', async () => {
    const server = new FakeStreamServer();
    const { client, applied } = start(server);
    const connection = await server.connection(0);
    connection.send(snapshotFrame(snapshotAt(1)));
    await until(() => client.version === 1);
    await client.close();
    expect(connection.isAborted).toBe(true);
    connection.send(snapshotFrame(snapshotAt(2)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.connections).toHaveLength(1);
    expect(applied.map((snapshot) => snapshot.version)).toEqual([1]);
    expect(client.version).toBe(1);
  });
});

interface ConformanceCase {
  readonly id: number;
  readonly flag: Flag;
  readonly context: Context;
  readonly expected: Evaluation;
}

/** value, reason, rule index and bucket, with an absent field as null. */
function fieldsOf(result: unknown): unknown[] {
  const r = result as { value?: boolean; reason?: string; ruleIndex?: number; bucket?: number };
  return [r.value, r.reason, r.ruleIndex ?? null, r.bucket ?? null];
}

describe('SDK evaluation', () => {
  it('evaluate() over snapshots received from the stream gives the expected value, reason, rule index and bucket for all 551 conformance cases, and undefined for a flag it does not hold', async () => {
    const cases = JSON.parse(
      readFileSync(new URL(import.meta.resolve('@rff/core/conformance.json')), 'utf8'),
    ) as ConformanceCase[];
    expect(cases).toHaveLength(551);
    const server = new FakeStreamServer();
    const { client } = start(server);
    const results: unknown[][] = [];
    client.onChange((snapshot) => {
      const entry = cases[snapshot.version - 1] as ConformanceCase;
      results.push(fieldsOf(client.evaluate(entry.flag.key, entry.context)));
    });
    // One snapshot per case, its flag alone, at version id; written as one body cut
    // into 97-byte chunks.
    const body = cases
      .map((entry) => snapshotFrame({ tenantId: TENANT, version: entry.id, flags: [entry.flag] }))
      .join(': hb\n\n');
    const bytes = new TextEncoder().encode(body);
    const connection = await server.connection(0);
    for (let offset = 0; offset < bytes.length; offset += 97) {
      connection.send(bytes.subarray(offset, offset + 97));
    }
    await until(() => client.version === 551, 10_000, 'version 551');
    expect(cases.map((entry) => entry.id)).toEqual(cases.map((_, index) => index + 1));
    expect(results).toEqual(cases.map((entry) => fieldsOf(entry.expected)));
    expect(client.evaluate('no-such-flag', { key: 'user-1' })).toBeUndefined();
  });
});
