import { isDeepStrictEqual } from 'node:util';
import { evaluate } from '@rff/core';
import { describe, expect, it } from 'vitest';
import { CACHE_TTL_SECONDS, FlagsCache } from '../src/flags/flags-cache.js';
import { StreamHub } from '../src/stream/stream-hub.js';
import { type Finding, inSequence } from './isolation/detectors.js';
import { escapeGlob } from './harness/redis.js';
import { type Environment, startEnvironment } from './support/api.js';
import { FirstEntryCache, withCache } from './support/broken-caches.js';
import { databaseSnapshot, eventually } from './support/snapshots.js';
import { openStream } from './support/sse.js';

// The snapshot cache in Redis, through two Nest apps that share it as two replicas
// do. Reads are GET /flags and POST /evaluate as A's viewer, and GET /sdk/stream
// with A's SDK key; the cache counts its hits and misses on each app.

function viewerOf(env: Environment) {
  return env.world.people.viewerOfA;
}

function readFlags(env: Environment, via: number) {
  return env.send(
    viewerOf(env),
    { method: 'GET', path: `/tenants/${env.world.fixture.tenantA}/flags` },
    via,
  );
}

const CONTEXT = { key: 'user-7', attributes: { country: 'NL' } };

function evaluateAll(env: Environment, via: number) {
  return env.send(
    viewerOf(env),
    { method: 'POST', path: `/tenants/${env.world.fixture.tenantA}/evaluate`, body: CONTEXT },
    via,
  );
}

function changeCheckout(env: Environment, rolloutBasisPoints: number, via: number) {
  return env.send(
    env.world.people.editorOfA,
    {
      method: 'PUT',
      path: `/tenants/${env.world.fixture.tenantA}/flags/checkout`,
      body: { enabled: true, rules: [], rolloutBasisPoints },
    },
    via,
  );
}

/** The first snapshot a stream opened on app via receives, parsed. */
async function streamSnapshot(env: Environment, via: number): Promise<unknown> {
  const stream = await openStream(env.apis[via]!.base, {
    authorization: `Bearer ${env.world.fixture.sdkKeys.aActive.key}`,
  });
  try {
    await stream.until(() => stream.events.length > 0, 'the first snapshot');
    return JSON.parse(stream.events[0]!.data);
  } finally {
    stream.close();
    // Until the app sees the stream end, a change would make it read for the stream.
    const hub = env.apis[via]!.app.get(StreamHub);
    await eventually(() => hub.tenantsWithStreams().length === 0, 'the stream to end');
  }
}

async function cacheKeys(env: Environment): Promise<string[]> {
  const keys: string[] = [];
  for await (const batch of env.redis.scanIterator({ MATCH: `${escapeGlob(env.redisPrefix)}:*` })) {
    keys.push(...batch);
  }
  return keys.toSorted();
}

/**
 * Sixteen saves, each through one app, with the cache warm (read just before) or
 * cold (emptied), and right after each one a read on one app of GET /flags, POST
 * /evaluate and a stream that opens. Each must return the save's version and the
 * database's flags, or for POST /evaluate what evaluate() gives over those flags.
 */
async function readAfterSaveFindings(env: Environment): Promise<Finding[]> {
  const findings: Finding[] = [];
  await inSequence(
    Array.from({ length: 16 }, (_, round) => round),
    async (round) => {
      const warm = round % 2 === 0;
      const writeVia = round % 2;
      const readVia = Math.floor(round / 2) % 2;
      if (warm) await readFlags(env, readVia);
      else await env.clearCache();
      // Everybody or nobody, in turn, so that an answer from before the save also
      // evaluates differently.
      const saved = await changeCheckout(env, round % 2 === 0 ? 0 : 10_000, writeVia);
      const { version } = saved.body as { version: number };
      const expected = await databaseSnapshot(env.admin, env.world.fixture.tenantA);
      const where = `round ${round}, ${warm ? 'warm' : 'cold'}, saved on app ${writeVia}, read on app ${readVia}`;
      const flags = (await readFlags(env, readVia)).body as { version: number; flags: unknown };
      if (flags.version !== version || !isDeepStrictEqual(flags.flags, expected.flags)) {
        findings.push({
          relation: 'GET /flags',
          detail: `${where}: not version ${version} with the database's flags`,
        });
      }
      const results = expected.flags.map((flag) =>
        Object.assign({ flagKey: flag.key }, evaluate(flag, CONTEXT)),
      );
      const evaluated = (await evaluateAll(env, readVia)).body;
      if (!isDeepStrictEqual(evaluated, { version, results })) {
        findings.push({
          relation: 'POST /evaluate',
          detail: `${where}: not version ${version} with the database's flags`,
        });
      }
      if (!isDeepStrictEqual(await streamSnapshot(env, readVia), expected)) {
        findings.push({
          relation: 'GET /sdk/stream',
          detail: `${where}: not version ${version} with the database's flags`,
        });
      }
    },
  );
  return findings;
}

describe('the snapshot cache', () => {
  it(`a read misses and writes <prefix>:flags:<tenantId>:v<version> for ${CACHE_TTL_SECONDS} s, which then answers both apps and a stream that opens; a change deletes the previous version's entry, the next read misses at the new version and the one after hits, and every entry and answer is the snapshot as the database holds it`, async () => {
    const env = await startEnvironment('cache', [{}, {}]);
    try {
      const tenantId = env.world.fixture.tenantA;
      const caches = env.apis.map((api) => api.app.get(FlagsCache));
      const counts = () => caches.map((cache) => ({ hits: cache.hits, misses: cache.misses }));
      const key = (version: number) => `${env.redisPrefix}:flags:${tenantId}:v${version}`;
      const atThree = await databaseSnapshot(env.admin, tenantId);
      expect(atThree.version).toBe(3);

      const first = await readFlags(env, 0);
      expect(first.body).toEqual({ version: 3, flags: atThree.flags });
      expect(counts()).toEqual([
        { hits: 0, misses: 1 },
        { hits: 0, misses: 0 },
      ]);
      expect(JSON.parse((await env.redis.get(key(3))) as string)).toEqual(atThree);
      const ttl = await env.redis.ttl(key(3));
      expect(ttl).toBeGreaterThan(CACHE_TTL_SECONDS - 60);
      expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS);

      expect((await readFlags(env, 1)).body).toEqual({ version: 3, flags: atThree.flags });
      expect(((await evaluateAll(env, 0)).body as { version: number }).version).toBe(3);
      expect(await streamSnapshot(env, 1)).toEqual(atThree);
      expect(counts()).toEqual([
        { hits: 1, misses: 1 },
        { hits: 2, misses: 0 },
      ]);

      const change = await changeCheckout(env, 4321, 1);
      expect((change.body as { version: number }).version).toBe(4);
      expect(await env.redis.exists(key(3))).toBe(0);
      const atFour = await databaseSnapshot(env.admin, tenantId);
      expect((await readFlags(env, 0)).body).toEqual({ version: 4, flags: atFour.flags });
      expect((await readFlags(env, 1)).body).toEqual({ version: 4, flags: atFour.flags });
      expect(counts()).toEqual([
        { hits: 1, misses: 2 },
        { hits: 3, misses: 0 },
      ]);
      expect(await cacheKeys(env)).toEqual([key(4)]);
      expect(JSON.parse((await env.redis.get(key(4))) as string)).toEqual(atFour);
    } finally {
      await env.close();
    }
  });

  it('a read that starts after a save returns the version and flags of that save, with the cache warm and cold, on the app that saved and on the other one, through GET /flags, POST /evaluate and a stream that opens', async () => {
    const env = await startEnvironment('cachesave', [{}, {}]);
    try {
      expect(await readAfterSaveFindings(env)).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it('control: with a cache that keeps the first entry stored for a tenant and answers every version with it, a read after a save returns the flags from before the save, and the same check reports it', async () => {
    const env = await startEnvironment(
      'cachestale',
      [0, 1].map(() => ({ override: (builder) => withCache(builder, FirstEntryCache) })),
    );
    try {
      const findings = await readAfterSaveFindings(env);
      expect(findings.length).toBeGreaterThan(0);
      for (const relation of ['GET /flags', 'POST /evaluate', 'GET /sdk/stream']) {
        expect(findings.some((finding) => finding.relation === relation)).toBe(true);
      }
    } finally {
      await env.close({ clearCache: true });
    }
  });
});
