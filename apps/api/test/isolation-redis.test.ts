import { isDeepStrictEqual } from 'node:util';
import { evaluate, type Flag } from '@rff/core';
import { FlagsClient, type SseEvent, SseParser } from '@rff/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagsCache } from '../src/flags/flags-cache.js';
import { escapeGlob } from './harness/redis.js';
import { type Finding, inSequence } from './isolation/detectors.js';
import { canaryReplyFindings } from './isolation/routes.js';
import { type AppChanges, type Environment, type Reply, startEnvironment } from './support/api.js';
import {
  type CacheClass,
  TenantlessKeyCache,
  UncheckedTenantlessCache,
  withCache,
} from './support/broken-caches.js';
import { databaseSnapshot, eventually } from './support/snapshots.js';

// Tenant isolation in what the instances share through Redis: the change
// notifications that wake the stream fan-out on every instance, and the snapshot
// cache. The environment runs two Nest apps on one database and one Redis prefix,
// seeded with tenants A and B, whose flags have the same keys and different values
// and whose free-text columns in A hold canaries. These checks set B's version to
// A's, so that A's and B's snapshots have the same version numbers and only the
// tenant in a key or a message tells them apart. The controls at the end run the
// same checks against caches whose key leaves out the tenant.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONTEXT = { key: 'user-1', attributes: { plan: 'pro', country: 'NL' } };
const WAIT_MS = 3000;

let env: Environment;

beforeAll(async () => {
  env = await startEnvironment('isoredis', [{}, {}]);
});

afterAll(async () => {
  await env?.close();
});

/** Seeds the world and gives B the version A has, 3, with an empty cache. */
async function seedAtOneVersion(target: Environment): Promise<void> {
  await target.world.seed(target.admin);
  await target.admin.query('UPDATE public.tenants SET version = 3 WHERE id = $1', [
    target.world.fixture.tenantB,
  ]);
  await target.clearCache();
}

interface Recorded {
  readonly name: string;
  readonly tenantId: string;
  readonly client: FlagsClient;
  /** Every byte the client received over all its connections, decoded. */
  text: string;
}

/** An SDK client whose fetch keeps a copy of every byte it receives. */
function recordedClient(name: string, tenantId: string, base: string, sdkKey: string): Recorded {
  const recorded = { name, tenantId, text: '' } as Recorded;
  const decoder = new TextDecoder();
  const fetchAndRecord: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.body === null) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          recorded.text += decoder.decode(chunk, { stream: true });
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return Object.assign(recorded, {
    client: new FlagsClient({ url: base, sdkKey, fetch: fetchAndRecord }),
  });
}

function eventsIn(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  new SseParser((event) => events.push(event)).push(new TextEncoder().encode(text));
  return events;
}

function putCheckout(target: Environment, tenantId: string, rollout: number, via: number) {
  const { fixture, people } = target.world;
  return target.send(
    tenantId === fixture.tenantA ? people.shared : people.ownerOfB,
    {
      method: 'PUT',
      path: `/tenants/${tenantId}/flags/checkout`,
      body: { enabled: true, rules: [], rolloutBasisPoints: rollout },
    },
    via,
  );
}

/**
 * SDK clients of A and of B on each app. Once each holds version 3 (the marker), A
 * changes, through the first app, and then B, through the second; both changes make
 * version 4. Each of A's clients must end at A's version 4 as the database holds it.
 * On each of B's streams the first data frame after the marker must be B's own
 * change, as the database holds it, and nothing B's clients received may hold a
 * canary of A.
 */
async function streamFindings(target: Environment): Promise<Finding[]> {
  const { fixture } = target.world;
  await seedAtOneVersion(target);
  const findings: Finding[] = [];
  const finding = (detail: string): void => {
    findings.push({ relation: 'GET /sdk/stream', detail });
  };
  const clients = target.apis.flatMap((api, index) => [
    recordedClient(
      `A's client on app ${index}`,
      fixture.tenantA,
      api.base,
      fixture.sdkKeys.aActive.key,
    ),
    recordedClient(
      `B's client on app ${index}`,
      fixture.tenantB,
      api.base,
      fixture.sdkKeys.bActive.key,
    ),
  ]);
  const ofA = clients.filter((client) => client.tenantId === fixture.tenantA);
  const ofB = clients.filter((client) => client.tenantId === fixture.tenantB);
  try {
    await inSequence(clients, (recorded) =>
      eventually(() => recorded.client.version === 3, `${recorded.name} at version 3`),
    );
    const markers = new Map(clients.map((recorded) => [recorded, recorded.text.length]));

    expect((await putCheckout(target, fixture.tenantA, 1111, 0)).status).toBe(200);
    const atA = await databaseSnapshot(target.admin, fixture.tenantA);
    await inSequence(ofA, async (recorded) => {
      const ok = () =>
        recorded.client.version === 4 && isDeepStrictEqual(recorded.client.flags, atA.flags);
      await eventually(ok, `${recorded.name} at A's version 4`, WAIT_MS).catch(() => {
        finding(`${recorded.name} does not hold A's version 4`);
      });
    });

    expect((await putCheckout(target, fixture.tenantB, 2222, 1)).status).toBe(200);
    const atB = await databaseSnapshot(target.admin, fixture.tenantB);
    await inSequence(ofB, async (recorded) => {
      const after = () => eventsIn(recorded.text.slice(markers.get(recorded)));
      await eventually(
        () => after().length > 0,
        `a data frame for ${recorded.name}`,
        WAIT_MS,
      ).catch(() => {});
      const [first] = after();
      const own =
        first?.type === 'snapshot' &&
        first.lastEventId === '4' &&
        isDeepStrictEqual(JSON.parse(first.data), atB);
      if (!own) {
        finding(
          `${recorded.name}: the first data frame after the marker is not B's change (${first === undefined ? 'none' : `id ${first.lastEventId}, ${first.data}`})`,
        );
      }
    });
    for (const leak of canaryReplyFindings(
      ofB.map((recorded) => ({ route: recorded.name, reply: { text: recorded.text } })),
      fixture.canaries,
    )) {
      finding(`${leak.relation}: ${leak.detail}`);
    }
    return findings;
  } finally {
    await Promise.all(clients.map((recorded) => recorded.client.close()));
  }
}

/**
 * Warms A's cache at version 3 on the first app, then reads B, at version 3 too,
 * as the user who is owner in A and viewer in B: GET /flags and POST /evaluate on
 * each app. Each must give B's flags, or B's evaluations, and no canary of A.
 */
async function cacheReadFindings(target: Environment): Promise<Finding[]> {
  const { fixture, people } = target.world;
  await seedAtOneVersion(target);
  const findings: Finding[] = [];
  const readA = await target.send(
    people.shared,
    { method: 'GET', path: `/tenants/${fixture.tenantA}/flags` },
    0,
  );
  expect(readA.status).toBe(200);
  const key = target.apis[0]!.app.get(FlagsCache).key(fixture.tenantA, 3);
  if ((await target.redis.exists(key)) !== 1) {
    findings.push({ relation: 'cache', detail: `A's entry ${key} is not in Redis` });
  }
  const atB = await databaseSnapshot(target.admin, fixture.tenantB);
  const expected = atB.flags.map((flag: Flag) =>
    Object.assign({ flagKey: flag.key }, evaluate(flag, CONTEXT)),
  );
  const replies: { route: string; reply: Reply }[] = [];
  await inSequence([0, 1], async (via) => {
    const flags = await target.send(
      people.shared,
      { method: 'GET', path: `/tenants/${fixture.tenantB}/flags` },
      via,
    );
    replies.push({ route: `GET /flags in B on app ${via}`, reply: flags });
    if (!isDeepStrictEqual(flags.body, { version: 3, flags: atB.flags })) {
      findings.push({ relation: `GET /flags in B on app ${via}`, detail: flags.text });
    }
    const evaluated = await target.send(
      people.shared,
      { method: 'POST', path: `/tenants/${fixture.tenantB}/evaluate`, body: CONTEXT },
      via,
    );
    replies.push({ route: `POST /evaluate in B on app ${via}`, reply: evaluated });
    if (!isDeepStrictEqual(evaluated.body, { version: 3, results: expected })) {
      findings.push({ relation: `POST /evaluate in B on app ${via}`, detail: evaluated.text });
    }
  });
  findings.push(...canaryReplyFindings(replies, fixture.canaries));
  return findings;
}

/**
 * Every key under the environment's prefix must be <prefix>:flags:<tenant>:v<n> for
 * A or B, and hold the snapshot of that tenant at that version as the database
 * holds it. No write follows the reads that wrote them, so that version is the
 * tenant's current one.
 */
async function keyFindings(target: Environment): Promise<{ findings: Finding[]; keys: number }> {
  const { tenantA, tenantB } = target.world.fixture;
  const prefix = target.redisPrefix;
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:flags:(${UUID}):v(0|[1-9][0-9]*)$`,
  );
  const findings: Finding[] = [];
  let keys = 0;
  for await (const batch of target.redis.scanIterator({ MATCH: `${escapeGlob(prefix)}:*` })) {
    for (const key of batch) {
      keys += 1;
      const match = pattern.exec(key);
      if (match === null) {
        findings.push({ relation: key, detail: 'is not <prefix>:flags:<tenant>:v<version>' });
        continue;
      }
      const [, tenantId, version] = match;
      if (tenantId !== tenantA && tenantId !== tenantB) {
        findings.push({ relation: key, detail: 'names a tenant other than A and B' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one key after another
      const entry: unknown = JSON.parse((await target.redis.get(key)) ?? 'null');
      // eslint-disable-next-line no-await-in-loop -- one key after another
      const held = await databaseSnapshot(target.admin, tenantId as string);
      if (held.version !== Number(version) || !isDeepStrictEqual(entry, held)) {
        findings.push({
          relation: key,
          detail: 'does not hold the snapshot of that tenant and version as the database holds it',
        });
      }
    }
  }
  return { findings, keys };
}

const twoAppsWith = (cache: CacheClass): AppChanges[] =>
  [0, 1].map(() => ({ override: (builder) => withCache(builder, cache) }));

const details = (findings: readonly Finding[]): string[] =>
  findings.map((finding) => `${finding.relation}: ${finding.detail}`);

describe('cross-instance isolation', () => {
  it("B's clients first get B's change, with no canary of A", async () => {
    expect(details(await streamFindings(env))).toEqual([]);
  });

  it("with A's cache warm, B's reads return B's data", async () => {
    expect(details(await cacheReadFindings(env))).toEqual([]);
  });

  it('afterwards every Redis key is <prefix>:flags:<tenant>:v<version> of A or B and holds that snapshot', async () => {
    const { findings, keys } = await keyFindings(env);
    expect(details(findings)).toEqual([]);
    expect(keys).toBeGreaterThanOrEqual(2);
  });

  it('control: a cache key without the tenant is reported', async () => {
    const keyless = await startEnvironment('isokeyless', twoAppsWith(TenantlessKeyCache));
    try {
      expect(details(await streamFindings(keyless))).toEqual([]);
      expect(details(await cacheReadFindings(keyless))).toEqual([]);
      const { findings, keys } = await keyFindings(keyless);
      expect(keys).toBeGreaterThan(0);
      expect(findings.map((finding) => finding.detail)).toEqual(
        Array.from({ length: keys }, () => 'is not <prefix>:flags:<tenant>:v<version>'),
      );
    } finally {
      await keyless.close({ clearCache: true });
    }

    const unchecked = await startEnvironment('isounchecked', twoAppsWith(UncheckedTenantlessCache));
    try {
      const fromStreams = details(await streamFindings(unchecked));
      for (const index of [0, 1]) {
        expect(fromStreams).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^GET /sdk/stream: B's client on app ${index}: the first data frame after the marker is not B's change`,
            ),
          ),
        );
      }
      expect(fromStreams.some((detail) => detail.includes('holds the canary of'))).toBe(true);
      const fromReads = details(await cacheReadFindings(unchecked));
      for (const route of ['GET /flags', 'POST /evaluate']) {
        for (const index of [0, 1]) {
          expect(
            fromReads.some((detail) => detail.startsWith(`${route} in B on app ${index}: `)),
          ).toBe(true);
        }
      }
      expect(fromReads.some((detail) => detail.includes('holds the canary of'))).toBe(true);
    } finally {
      await unchecked.close({ clearCache: true });
    }
  });
});
