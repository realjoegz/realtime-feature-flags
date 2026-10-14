import { type MessageEvent } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config } from '../src/config.js';
import type { Snapshot } from '../src/flags/flag-store.js';
import { SnapshotReader, type TenantRead } from '../src/stream/snapshot-reader.js';
import { NO_CURSOR, StreamHub } from '../src/stream/stream-hub.js';
import { PG_POOL } from '../src/tokens.js';
import { inSequence } from './isolation/detectors.js';
import { type Environment, startEnvironment, UNUSED_AUTH } from './support/api.js';
import { databaseSnapshot, eventually } from './support/snapshots.js';
import { openStream, type OpenStream } from './support/sse.js';

// GET /sdk/stream on one instance, read with fetch: what a connection receives for
// each cursor, the frame format, the fan-out's reads, and shutdown.

const HEARTBEAT_MS = 50;

let env: Environment;
let keyOfA: string;

beforeAll(async () => {
  env = await startEnvironment('stream', {
    configure: (config) => ({ ...config, stream: { heartbeatMs: HEARTBEAT_MS } }),
  });
  keyOfA = `Bearer ${env.world.fixture.sdkKeys.aActive.key}`;
});

afterAll(async () => {
  await env?.close();
});

function changeCheckout(rolloutBasisPoints: number) {
  return env.send(env.world.people.editorOfA, {
    method: 'PUT',
    path: `/tenants/${env.world.fixture.tenantA}/flags/checkout`,
    body: { enabled: true, rules: [], rolloutBasisPoints },
  });
}

const versionsOf = (stream: OpenStream): string[] =>
  stream.events.map((event) => event.lastEventId);

describe('GET /sdk/stream', () => {
  it("without a cursor sends the tenant's snapshot at once as one event whose id is the version, whose event is snapshot and whose data is the tenant id, version and flags as the database holds them", async () => {
    await env.world.seed(env.admin);
    const stream = await openStream(env.api.base, { authorization: keyOfA });
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
      await stream.until(() => stream.events.length === 1, 'the snapshot');
      const expected = await databaseSnapshot(env.admin, env.world.fixture.tenantA);
      expect(expected.version).toBe(3);
      expect(expected.flags).toHaveLength(3);
      // Nest writes one newline with the headers, then the event. A heartbeat can come
      // first when the read takes longer than one interval.
      expect(stream.text).toMatch(/^\n(?:: hb\n\n)*event: snapshot\nid: 3\ndata: \{[^\n]*\}\n\n/);
      expect(stream.events[0]).toMatchObject({ type: 'snapshot', lastEventId: '3' });
      expect(JSON.parse(stream.events[0]!.data)).toEqual(expected);
    } finally {
      stream.close();
    }
  });

  it('with a cursor at the tenant version sends heartbeats and no data until the next change, whose snapshot comes next; a lower cursor gets the snapshot at once; Last-Event-ID takes precedence over ?cursor=', async () => {
    await env.world.seed(env.admin);
    const open = (lastEventId: string | undefined, query?: string) =>
      openStream(env.api.base, {
        authorization: keyOfA,
        ...(lastEventId === undefined ? {} : { lastEventId }),
        ...(query === undefined ? {} : { query }),
      });
    const streams = {
      header: await open('3'),
      query: await open(undefined, '?cursor=3'),
      headerOverQuery: await open('3', '?cursor=0'),
      behind: await open(undefined, '?cursor=2'),
      behindByHeader: await open('2', '?cursor=3'),
    };
    try {
      const all = Object.values(streams);
      await inSequence([streams.behind, streams.behindByHeader], (stream) =>
        stream.until(() => stream.events.length === 1, 'the snapshot'),
      );
      // A snapshot sent to the other streams by the same reads would come before the
      // next heartbeats on each of them.
      const beats = new Map(all.map((stream) => [stream, stream.heartbeats]));
      await inSequence(all, (stream) =>
        stream.until(() => stream.heartbeats >= (beats.get(stream) ?? 0) + 2, '2 more heartbeats'),
      );
      expect(
        Object.fromEntries(Object.entries(streams).map(([name, s]) => [name, versionsOf(s)])),
      ).toEqual({
        header: [],
        query: [],
        headerOverQuery: [],
        behind: ['3'],
        behindByHeader: ['3'],
      });

      const change = await changeCheckout(4321);
      expect(change.status).toBe(200);
      expect((change.body as { version: number }).version).toBe(4);
      await inSequence(all, (stream) =>
        stream.until(() => stream.events.at(-1)?.lastEventId === '4', 'version 4'),
      );
      const expected = await databaseSnapshot(env.admin, env.world.fixture.tenantA);
      expect(
        Object.fromEntries(Object.entries(streams).map(([name, s]) => [name, versionsOf(s)])),
      ).toEqual({
        header: ['4'],
        query: ['4'],
        headerOverQuery: ['4'],
        behind: ['3', '4'],
        behindByHeader: ['3', '4'],
      });
      for (const stream of all) expect(JSON.parse(stream.events.at(-1)!.data)).toEqual(expected);
    } finally {
      for (const stream of Object.values(streams)) stream.close();
    }
  });

  it('heartbeats are comment frames ": hb" with no id, no more than one per interval, and every other frame is a snapshot event', async () => {
    await env.world.seed(env.admin);
    const stream = await openStream(env.api.base, { authorization: keyOfA });
    try {
      const opened = performance.now();
      await stream.until(() => stream.heartbeats >= 6, '6 heartbeats');
      await changeCheckout(10);
      await stream.until(() => stream.events.length === 2, 'the second snapshot');
      await stream.until(() => stream.text.endsWith(': hb\n\n'), 'a heartbeat after it');
      const elapsed = performance.now() - opened;
      expect(stream.heartbeats).toBeLessThanOrEqual(Math.floor(elapsed / HEARTBEAT_MS) + 1);
      const frames = stream.text.slice(1).split('\n\n').slice(0, -1);
      expect(stream.text.startsWith('\n')).toBe(true);
      expect(frames.filter((frame) => frame !== ': hb')).toEqual([
        expect.stringMatching(/^event: snapshot\nid: 3\ndata: [^\n]+$/),
        expect.stringMatching(/^event: snapshot\nid: 4\ndata: [^\n]+$/),
      ]);
      expect(frames.filter((frame) => frame === ': hb')).toHaveLength(stream.heartbeats);
    } finally {
      stream.close();
    }
  });

  it('a cursor that is not a version gets 400 before any stream opens, and so does a repeated cursor parameter', async () => {
    const cases: [string | undefined, string | undefined][] = [
      ['abc', undefined],
      ['-1', undefined],
      ['01', undefined],
      ['4, 5', undefined],
      [undefined, '?cursor=1.5'],
      [undefined, '?cursor=9007199254740992'],
      [undefined, '?cursor=1&cursor=2'],
    ];
    const replies = await inSequence(cases, async ([lastEventId, query]) => {
      const stream = await openStream(env.api.base, {
        authorization: keyOfA,
        ...(lastEventId === undefined ? {} : { lastEventId }),
        ...(query === undefined ? {} : { query }),
      });
      const reply = await stream.reply();
      return [reply.status, reply.headers['content-type'], reply.body];
    });
    for (const reply of replies) {
      expect(reply).toEqual([
        400,
        expect.stringMatching(/^application\/json/),
        {
          statusCode: 400,
          message: 'invalid cursor',
          errors: ['cursor: must be a version, an integer from 0 to 9007199254740991'],
        },
      ]);
    }
  });
});

describe('stream fan-out', () => {
  it('open streams hold no pooled connection: 12 streams on a pool of 2 each get their snapshot and the latest change, and between reads every pooled connection is idle', async () => {
    const small = await startEnvironment('streampool', {
      configure: (config) => ({ ...config, database: { ...config.database, poolMax: 2 } }),
    });
    const streams: OpenStream[] = [];
    try {
      const { fixture, people } = small.world;
      const keys = [fixture.sdkKeys.aActive.key, fixture.sdkKeys.bActive.key];
      streams.push(
        ...(await inSequence(
          Array.from({ length: 12 }, (_, index) => keys[index % 2]),
          (key) => openStream(small.api.base, { authorization: `Bearer ${key}` }),
        )),
      );
      await inSequence(streams, (stream) =>
        stream.until(() => stream.events.length === 1, 'the first snapshot'),
      );
      const pool = small.api.app.get<pg.Pool>(PG_POOL);
      // A read that a stream opening during another read asked for can still be
      // running; once it ends, no connection is checked out and nothing waits.
      const allIdle = () => pool.idleCount === pool.totalCount && pool.waitingCount === 0;
      await eventually(allIdle, 'every pooled connection idle', 2000);
      expect(pool.totalCount).toBeLessThanOrEqual(2);

      for (const rollout of [1, 2, 3]) {
        // eslint-disable-next-line no-await-in-loop -- one write after another
        const reply = await small.send(people.editorOfA, {
          method: 'PUT',
          path: `/tenants/${fixture.tenantA}/flags/search`,
          body: { enabled: true, rules: [], rolloutBasisPoints: rollout },
        });
        expect(reply.status).toBe(200);
      }
      const ofA = streams.filter((_, index) => index % 2 === 0);
      const ofB = streams.filter((_, index) => index % 2 === 1);
      await inSequence(ofA, (stream) =>
        stream.until(() => stream.events.at(-1)?.lastEventId === '6', 'version 6'),
      );
      const expected = await databaseSnapshot(small.admin, fixture.tenantA);
      for (const stream of ofA) expect(JSON.parse(stream.events.at(-1)!.data)).toEqual(expected);
      for (const stream of ofB) expect(versionsOf(stream)).toEqual(['1']);
      await eventually(allIdle, 'every pooled connection idle', 2000);
      expect(pool.totalCount).toBeLessThanOrEqual(2);
    } finally {
      for (const stream of streams) stream.close();
      await small.close();
    }
  });

  it('a wake-up that arrives during a read causes exactly one more read, however many arrive; a wake-up for a tenant with no open stream reads nothing', async () => {
    const reader = new GatedReader();
    const hub = new StreamHub(hubConfig, reader);
    const events: MessageEvent[] = [];
    let completed = false;
    hub.wake(OTHER_TENANT);
    const subscription = hub.stream(TENANT, NO_CURSOR).subscribe({
      next: (event) => events.push(event),
      complete: () => {
        completed = true;
      },
    });
    // The new stream wakes its tenant: the first read starts and waits at its gate.
    expect(reader.calls).toEqual([{ tenantId: TENANT, above: NO_CURSOR }]);
    for (let wake = 0; wake < 5; wake += 1) hub.wake(TENANT);
    expect(reader.calls).toHaveLength(1);

    reader.version = 5;
    await reader.release();
    // The first read sent version 5; the five wake-ups gave one more read, from 5.
    expect(reader.calls).toEqual([
      { tenantId: TENANT, above: NO_CURSOR },
      { tenantId: TENANT, above: 5 },
    ]);
    await reader.release();
    expect(reader.calls).toHaveLength(2);
    expect(events.map((event) => event.id)).toEqual(['5']);

    reader.version = 6;
    hub.wake(TENANT);
    await reader.release();
    expect(reader.calls).toHaveLength(3);
    expect(events.map((event) => [event.id, event.type])).toEqual([
      ['5', 'snapshot'],
      ['6', 'snapshot'],
    ]);
    expect(JSON.parse(events[1]!.data as string)).toEqual({
      tenantId: TENANT,
      version: 6,
      flags: [],
    });
    expect(reader.calls.some((call) => call.tenantId === OTHER_TENANT)).toBe(false);

    await hub.beforeApplicationShutdown();
    expect(completed).toBe(true);
    subscription.unsubscribe();
  });

  it('close() completes every open stream while heartbeats flow, each client sees the end of the body and no reset, and close() returns within 1 s', async () => {
    // A heartbeat every 10 ms keeps bytes in flight on every stream when close()
    // starts, so a shutdown that destroys the sockets before the ends are written
    // shows as failed bodies.
    const closing = await startEnvironment('streamclose', {
      configure: (config) => ({ ...config, stream: { heartbeatMs: 10 } }),
    });
    const key = `Bearer ${closing.world.fixture.sdkKeys.aActive.key}`;
    const streams = await Promise.all(
      Array.from({ length: 20 }, () => openStream(closing.api.base, { authorization: key })),
    );
    await inSequence(streams, (stream) =>
      stream.until(
        () => stream.events.length === 1 && stream.heartbeats >= 3,
        'the first snapshot and 3 heartbeats',
      ),
    );
    const started = performance.now();
    await closing.close();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await Promise.all(streams.map((stream) => stream.ended))).toEqual(
      streams.map(() => 'ended'),
    );
  });
});

const TENANT = '0f4c9a8e-2b7d-4e61-9c3a-5d8e7f6a1b20';
const OTHER_TENANT = '7a2e5c1d-8f3b-4a96-b0e4-2c6d9a1f3e58';

const hubConfig: Config = {
  http: { host: '127.0.0.1', port: 0 },
  instance: 'hub-test',
  database: { url: 'postgres://unused@127.0.0.1:9/unused', poolMax: 1, connectDeadlineMs: 0 },
  auth: { ...UNUSED_AUTH, audience: 'rff-api' },
  // Long enough that no heartbeat comes during the test.
  stream: { heartbeatMs: 600_000 },
};

/** A reader whose reads each wait until the test releases them, and that records each call. */
class GatedReader extends SnapshotReader {
  readonly calls: { tenantId: string; above: number }[] = [];
  version = 0;
  private readonly gates: (() => void)[] = [];

  constructor() {
    super(undefined as never);
  }

  override async read(tenantId: string, above: number): Promise<TenantRead | null> {
    this.calls.push({ tenantId, above });
    await new Promise<void>((resolve) => this.gates.push(resolve));
    const snapshot: Snapshot = { tenantId, version: this.version, flags: [] };
    return { version: this.version, snapshot: this.version > above ? snapshot : null };
  }

  /** Lets the oldest waiting read finish, and waits until the hub has acted on it. */
  async release(): Promise<void> {
    const gate = this.gates.shift();
    if (gate === undefined) throw new Error('no read is waiting');
    gate();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
