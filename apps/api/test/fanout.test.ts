import type { TestingModuleBuilder } from '@nestjs/testing';
import { FlagsClient } from '@rff/sdk';
import { describe, expect, it } from 'vitest';
import { type Config } from '../src/config.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import { FlagsCache } from '../src/flags/flags-cache.js';
import { RedisConnection } from '../src/redis/redis-connection.js';
import { parseChange } from '../src/stream/change-bus.js';
import { SnapshotReader, type TenantRead } from '../src/stream/snapshot-reader.js';
import { StreamHub } from '../src/stream/stream-hub.js';
import { harness } from './harness/context.js';
import { inSequence } from './isolation/detectors.js';
import { type AppChanges, type Environment, startEnvironment } from './support/api.js';
import {
  BusFaults,
  type FaultyBusOptions,
  killConnection,
  subscriberName,
  withFaultyBus,
} from './support/bus-faults.js';
import { Gate } from './support/gate.js';
import { databaseSnapshot, eventually } from './support/snapshots.js';
import { openStream, type OpenStream } from './support/sse.js';

// Change notifications between two Nest apps in this process, on separate ports,
// sharing one database and one Redis prefix as two replicas do: what a save
// publishes, which streams it reaches, what happens when an instance's subscriber
// reconnects, and how the safety poll covers notifications that are lost.

const HEARTBEAT_MS = 50;
const POLL_MS = 250;
const POLL_MARGIN_MS = 750;

function withPoll(poll: number | null) {
  return (config: Config): Config => ({
    ...config,
    stream: { heartbeatMs: HEARTBEAT_MS, safetyPollMs: poll },
  });
}

function twoApps(poll: number | null, faults?: BusFaults, options?: FaultyBusOptions) {
  const configure = withPoll(poll);
  return [0, 1].map((index): AppChanges =>
    faults === undefined
      ? { configure }
      : { configure, override: (builder) => withFaultyBus(builder, faults, index, options) },
  );
}

function hubOf(env: Environment, index: number): StreamHub {
  return env.apis[index]!.app.get(StreamHub);
}

function putCheckout(env: Environment, tenantId: string, rollout: number, via: number) {
  const { fixture, people } = env.world;
  return env.send(
    tenantId === fixture.tenantA ? people.shared : people.ownerOfB,
    {
      method: 'PUT',
      path: `/tenants/${tenantId}/flags/checkout`,
      body: { enabled: true, rules: [], rolloutBasisPoints: rollout },
    },
    via,
  );
}

async function openFor(env: Environment, key: string, via: number): Promise<OpenStream> {
  return openStream(env.apis[via]!.base, { authorization: `Bearer ${key}` });
}

/** What work resolves to, and how many milliseconds it took. */
async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await work();
  return [result, performance.now() - started];
}

const lastVersion = (stream: OpenStream): string | undefined => stream.events.at(-1)?.lastEventId;

/** The stream fan-out's reader, recording the tenant of every read it is asked for. */
class RecordingReader extends SnapshotReader {
  readonly tenants: string[] = [];

  override read(tenantId: string, above: number): Promise<TenantRead | null> {
    this.tenants.push(tenantId);
    return super.read(tenantId, above);
  }
}

function withRecordingReader(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(SnapshotReader).useFactory({
    factory: (db: TenantDatabase, cache: FlagsCache) => new RecordingReader(db, cache),
    inject: [TenantDatabase, FlagsCache],
  });
}

describe('change notifications between two instances', () => {
  it("a save through one instance publishes one message {tenantId, version} on <prefix>:changes, and it brings the tenant's open streams on both instances to the new version with the safety poll off, while neither instance reads the other tenant, whose streams are open on both; messages that are not a change are ignored", async () => {
    const env = await startEnvironment(
      'fanout',
      [0, 1].map((): AppChanges => ({ configure: withPoll(null), override: withRecordingReader })),
    );
    const listener = env.redis.duplicate();
    const streams: OpenStream[] = [];
    const ofB: OpenStream[] = [];
    try {
      const { fixture } = env.world;
      const messages: string[] = [];
      await listener.connect();
      await listener.subscribe(`${env.redisPrefix}:changes`, (message) => messages.push(message));
      streams.push(
        await openFor(env, fixture.sdkKeys.aActive.key, 0),
        await openFor(env, fixture.sdkKeys.aActive.key, 1),
      );
      ofB.push(
        await openFor(env, fixture.sdkKeys.bActive.key, 0),
        await openFor(env, fixture.sdkKeys.bActive.key, 1),
      );
      await inSequence(streams, (stream) => stream.until(() => lastVersion(stream) === '3', 'v3'));
      await inSequence(ofB, (stream) => stream.until(() => lastVersion(stream) === '1', "B's v1"));

      // Neither instance stops on a message it cannot read, and neither reads it as a change.
      const notChanges = [
        'not json',
        JSON.stringify({ tenantId: 'not-a-uuid', version: 4 }),
        JSON.stringify({ tenantId: fixture.tenantA, version: '4' }),
      ];
      for (const message of notChanges) {
        expect(parseChange(message)).toBeNull();
        // eslint-disable-next-line no-await-in-loop -- in order
        await env.redis.publish(`${env.redisPrefix}:changes`, message);
      }
      const reply = await putCheckout(env, fixture.tenantA, 4321, 0);
      expect(reply.status).toBe(200);
      await inSequence(streams, (stream) => stream.until(() => lastVersion(stream) === '4', 'v4'));
      const expected = await databaseSnapshot(env.admin, fixture.tenantA);
      for (const stream of streams) {
        expect(stream.events.map((event) => event.lastEventId)).toEqual(['3', '4']);
        expect(JSON.parse(stream.events[1]!.data)).toEqual(expected);
      }
      await eventually(() => messages.length === 4, 'the four messages');
      expect(messages.slice(3)).toEqual([
        JSON.stringify({ tenantId: fixture.tenantA, version: 4 }),
      ]);
      expect(parseChange(messages[3]!)).toEqual({ tenantId: fixture.tenantA, version: 4 });
      // A wake-up starts its read at once, so a read of B for A's change would be
      // recorded by the time A's streams have the change.
      for (const index of [0, 1]) {
        expect(env.apis[index]!.app.get(SnapshotReader)).toBeInstanceOf(RecordingReader);
        expect((env.apis[index]!.app.get(SnapshotReader) as RecordingReader).tenants).toEqual([
          fixture.tenantA,
          fixture.tenantB,
          fixture.tenantA,
        ]);
        expect(ofB[index]!.events.map((event) => event.lastEventId)).toEqual(['1']);
        expect(hubOf(env, index).delivered).toEqual({
          connect: 2,
          notification: 1,
          ready: 0,
          poll: 0,
        });
      }
    } finally {
      for (const stream of [...streams, ...ofB]) stream.close();
      listener.destroy();
      await env.close();
    }
  });

  it("after an instance's subscriber loses its connection and is ready again, the instance reads every tenant with open streams, so changes whose notifications it missed reach them with the safety poll off", async () => {
    const faults = new BusFaults();
    const env = await startEnvironment('fanready', twoApps(null, faults));
    const streams: OpenStream[] = [];
    try {
      const { fixture } = env.world;
      const [ofA, ofB] = [
        await openFor(env, fixture.sdkKeys.aActive.key, 1),
        await openFor(env, fixture.sdkKeys.bActive.key, 1),
      ];
      streams.push(ofA!, ofB!);
      await ofA!.until(() => lastVersion(ofA!) === '3', "A's v3");
      await ofB!.until(() => lastVersion(ofB!) === '1', "B's v1");

      faults.dropNextAt(1);
      faults.dropNextAt(1);
      expect((await putCheckout(env, fixture.tenantA, 11, 0)).status).toBe(200);
      expect((await putCheckout(env, fixture.tenantB, 22, 0)).status).toBe(200);
      // The subscriber hears a message after the PUT reply, on its own connection.
      await eventually(() => (faults.dropped[1] ?? 0) === 2, 'both notifications lost at app 2');
      const beats = ofA!.heartbeats;
      await ofA!.until(() => ofA!.heartbeats >= beats + 4, '4 more heartbeats');
      expect([lastVersion(ofA!), lastVersion(ofB!)]).toEqual(['3', '1']);

      const killed = await killConnection(
        env.redis,
        subscriberName(env.redisPrefix, env.apis[1]!.instance),
      );
      expect(killed).toBe(1);
      await ofA!.until(() => lastVersion(ofA!) === '4', "A's v4 after the reconnect");
      await ofB!.until(() => lastVersion(ofB!) === '2', "B's v2 after the reconnect");
      expect(JSON.parse(ofA!.events.at(-1)!.data)).toEqual(
        await databaseSnapshot(env.admin, fixture.tenantA),
      );
      expect(JSON.parse(ofB!.events.at(-1)!.data)).toEqual(
        await databaseSnapshot(env.admin, fixture.tenantB),
      );
      expect(hubOf(env, 1).delivered).toMatchObject({ ready: 2, poll: 0 });
    } finally {
      for (const stream of streams) stream.close();
      await env.close();
    }
  });

  it('control: an instance that does not read again when its subscriber is ready leaves its streams behind the changes it missed until the next notification', async () => {
    const faults = new BusFaults();
    const env = await startEnvironment(
      'fannoready',
      twoApps(null, faults, { recheckOnReady: false }),
    );
    const stream = await openFor(env, env.world.fixture.sdkKeys.aActive.key, 1);
    try {
      const { fixture } = env.world;
      await stream.until(() => lastVersion(stream) === '3', 'v3');
      faults.dropNextAt(1);
      expect((await putCheckout(env, fixture.tenantA, 11, 0)).status).toBe(200);
      await eventually(() => (faults.dropped[1] ?? 0) === 1, 'the notification lost at app 2');
      const name = subscriberName(env.redisPrefix, env.apis[1]!.instance);
      expect(await killConnection(env.redis, name)).toBe(1);
      // The subscriber is back once a notification reaches the instance again.
      const listed = async () => String(await env.redis.sendCommand(['CLIENT', 'LIST']));
      await eventually(async () => (await listed()).includes(`name=${name} `), 'the reconnect');
      const beats = stream.heartbeats;
      await stream.until(() => stream.heartbeats >= beats + 10, '10 more heartbeats');
      expect(lastVersion(stream)).toBe('3');
      expect((await putCheckout(env, fixture.tenantA, 12, 0)).status).toBe(200);
      await stream.until(() => lastVersion(stream) === '5', 'v5');
      expect(stream.events.map((event) => event.lastEventId)).toEqual(['3', '5']);
    } finally {
      stream.close();
      await env.close();
    }
  });

  it(`a publish that throws does not fail the write, and with every notification lost and a safety poll every ${POLL_MS} ms, each of 10 changes reaches an SDK client on the other instance within ${POLL_MS} ms plus a margin of ${POLL_MARGIN_MS} ms, delivered by the poll`, async () => {
    const faults = new BusFaults();
    const env = await startEnvironment('fanpoll', twoApps(POLL_MS, faults));
    const sdkKey = env.world.fixture.sdkKeys.aActive.key;
    const arrivals = new Map<number, number>();
    const client = new FlagsClient({
      url: env.apis[1]!.base,
      sdkKey,
      heartbeatIntervalMs: HEARTBEAT_MS,
    });
    client.onChange((snapshot) => arrivals.set(snapshot.version, performance.now()));
    try {
      const { fixture } = env.world;
      await eventually(() => client.version === 3, 'the first snapshot');
      const before = { ...hubOf(env, 1).delivered };

      faults.failNextPublish();
      const failed = await putCheckout(env, fixture.tenantA, 100, 0);
      expect(failed.status).toBe(200);
      expect((failed.body as { version: number }).version).toBe(4);
      expect(faults.thrown).toBe(1);
      await eventually(() => client.version === 4, 'the change whose publish threw');

      faults.dropAll = true;
      const latencies = await inSequence(
        Array.from({ length: 10 }, (_, index) => index),
        async (index) => {
          const sent = performance.now();
          const reply = await putCheckout(env, fixture.tenantA, 200 + index, 0);
          const { version } = reply.body as { version: number };
          await eventually(() => arrivals.has(version), `version ${version}`, 5000);
          return (arrivals.get(version) as number) - sent;
        },
      );
      for (const latency of latencies) expect(latency).toBeLessThan(POLL_MS + POLL_MARGIN_MS);
      expect(client.flags).toEqual((await databaseSnapshot(env.admin, fixture.tenantA)).flags);
      const after = hubOf(env, 1).delivered;
      expect(after.poll - before.poll).toBe(11);
      expect(after.notification - before.notification).toBe(0);
      expect(faults.dropped[1]).toBeGreaterThanOrEqual(10);
    } finally {
      await client.close();
      await env.close();
    }
  });
  it(`while one app cannot reach Redis it answers reads from Postgres and its writes succeed, each in less than 1 s; the other app's streams get those writes from a safety poll every ${POLL_MS} ms, and once Redis is back the first app's writes reach them by notification again`, async () => {
    const gate = await Gate.open(harness().redisUrl);
    const [first, second] = twoApps(POLL_MS);
    const behindGate: AppChanges = {
      configure: (config) => {
        const changed = first!.configure!(config);
        return { ...changed, redis: { ...changed.redis, url: gate.url } };
      },
    };
    const env = await startEnvironment('fangate', [behindGate, second!]);
    const stream = await openFor(env, env.world.fixture.sdkKeys.aActive.key, 1);
    try {
      const { fixture } = env.world;
      await stream.until(() => lastVersion(stream) === '3', 'v3');
      const before = { ...hubOf(env, 1).delivered };
      const redis = env.apis[0]!.app.get(RedisConnection);
      await gate.close();
      await eventually(() => !redis.client.isReady, "the first app's Redis connection down");

      const [read, readMs] = await timed(() =>
        env.send(
          env.world.people.viewerOfA,
          { method: 'GET', path: `/tenants/${fixture.tenantA}/flags` },
          0,
        ),
      );
      const atThree = await databaseSnapshot(env.admin, fixture.tenantA);
      expect(read.body).toEqual({ version: 3, flags: atThree.flags });
      const [write, writeMs] = await timed(() => putCheckout(env, fixture.tenantA, 3333, 0));
      expect(write.status).toBe(200);
      expect((write.body as { version: number }).version).toBe(4);
      expect([readMs, writeMs].every((ms) => ms < 1000)).toBe(true);
      await stream.until(() => lastVersion(stream) === '4', 'v4 from the poll', 5000);
      expect(JSON.parse(stream.events.at(-1)!.data)).toEqual(
        await databaseSnapshot(env.admin, fixture.tenantA),
      );
      expect(hubOf(env, 1).delivered.poll - before.poll).toBe(1);

      await gate.reopen();
      await eventually(() => redis.client.isReady, "the first app's Redis connection back", 10_000);
      // The subscriber of the first app reconnects on its own schedule; a write's
      // notification needs only the publisher, on the commands connection.
      expect((await putCheckout(env, fixture.tenantA, 4444, 0)).status).toBe(200);
      await stream.until(() => lastVersion(stream) === '5', 'v5', 5000);
      expect(hubOf(env, 1).delivered.notification - before.notification).toBe(1);
    } finally {
      stream.close();
      await env.close();
      await gate.close();
    }
  });
});
