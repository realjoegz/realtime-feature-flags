import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Context, Flag, Rule } from '@rff/core';
import { FlagsClient, SnapshotError } from '@rff/sdk';
import fc from 'fast-check';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  TenantDatabase,
  type TenantClient,
  type TenantScope,
} from '../src/database/tenant-database.js';
import { FlagsCache } from '../src/flags/flags-cache.js';
import type { EvaluationResult } from '../src/flags/flags.service.js';
import { PG_POOL } from '../src/tokens.js';
import { type AppChanges, type Call, type Environment, startEnvironment } from './support/api.js';
import { FirstEntryCache, withCache } from './support/broken-caches.js';
import { label, runParams } from './support/fc-params.js';
import { eventually } from './support/snapshots.js';

// Agreement between the SDK and POST /evaluate. Each run saves a random set of
// flags through the API, on one of two apps that share Postgres and Redis, and waits
// until an SDK client connected to the first app holds the version of the last
// save. The client must hold exactly the flags as saved, with the salts the server
// chose. Then, for each of a few random contexts, POST /evaluate on the second app
// must answer at that version with results for exactly those flags, each with the
// value, reason, rule index and bucket that the SDK's evaluate() gives.
//
// Both sides run evaluate() from @rff/core, so this checks the path the flags take
// (POST and PUT bodies, Postgres, the Redis cache, JSON, the stream) and not the
// evaluation logic, which the conformance file and the reference evaluator in
// packages/core cover. Attribute names and values come from small shared pools, so
// rules often match and several rules can match one context; the pools hold
// non-ASCII text, near misses in Unicode normalization and names inherited from
// Object.prototype. The controls run the same property against apps whose storage
// loses the order of the rules, whose storage returns the percentage as a string,
// and whose second app evaluates from a stale cache entry.

const AGREEMENT = runParams(100);
const FLAG_KEYS = ['checkout', 'search', 'new-nav', 'beta_ui', 'x'] as const;
const NAMES = ['plan', 'country', 'r\u00e9gion', 're\u0301gion', '__proto__'] as const;
const VALUES = ['pro', 'NL', '', '\u00fc', 'u\u0308', '\u65e5\u672c'] as const;
const USER_KEYS = ['user-1', 'user-2', '', 'ü', 'ππππππππ', 'user-🚀'] as const;
/** A branch must be at least this share of all evaluations. */
const BRANCH_FLOOR = 0.05;

type FlagSettings = Omit<Flag, 'salt'>;

const rule: fc.Arbitrary<Rule> = fc.oneof(
  fc.record(
    {
      attribute: fc.constantFrom(...NAMES),
      operator: fc.constant('equals' as const),
      values: fc.constantFrom(...VALUES).map((value) => [value]),
      serve: fc.boolean(),
    },
    { noNullPrototype: true },
  ),
  fc.record(
    {
      attribute: fc.constantFrom(...NAMES),
      operator: fc.constant('in' as const),
      values: fc.uniqueArray(fc.constantFrom(...VALUES), { minLength: 1, maxLength: 3 }),
      serve: fc.boolean(),
    },
    { noNullPrototype: true },
  ),
);

const flagSettings: fc.Arbitrary<FlagSettings> = fc.record(
  {
    key: fc.constantFrom(...FLAG_KEYS),
    // One flag in five is disabled.
    enabled: fc.integer({ min: 0, max: 4 }).map((n) => n > 0),
    rules: fc.array(rule, { maxLength: 3 }),
    rolloutBasisPoints: fc.oneof(
      fc.constantFrom(0, 1, 5000, 9999, 10_000),
      fc.integer({ min: 0, max: 10_000 }),
    ),
  },
  { noNullPrototype: true },
);

const flagSet = fc.uniqueArray(flagSettings, {
  minLength: 1,
  maxLength: 4,
  selector: (flag) => flag.key,
});

const context: fc.Arbitrary<Context> = fc
  .record(
    {
      key: fc.oneof(fc.constantFrom(...USER_KEYS), fc.string({ maxLength: 12 })),
      attributes: fc.option(
        fc.uniqueArray(fc.tuple(fc.constantFrom(...NAMES), fc.constantFrom(...VALUES)), {
          maxLength: NAMES.length,
          selector: ([name]) => name,
        }),
        { nil: undefined },
      ),
    },
    { noNullPrototype: true },
  )
  // Object.fromEntries makes own properties, __proto__ included, as JSON.parse does.
  .map(({ key, attributes }) =>
    attributes === undefined ? { key } : { key, attributes: Object.fromEntries(attributes) },
  );

const contexts = fc.array(context, { minLength: 1, maxLength: 4 });

/** The writes of a run go through either app. */
const via = fc.nat(1);

type Branch = 'disabled' | 'rule' | 'rollout-in' | 'rollout-out';

interface Tally {
  runs: number;
  /** POST /evaluate requests, one per context. */
  requests: number;
  /**
   * Runs whose first POST /evaluate the second app answered from the cache. Each run
   * saves at least once, so that request asks for a version the second app has not
   * read before, and the second app writes an entry only after a miss: the entry it
   * found is the one the first app wrote when it read the snapshot for the stream.
   */
  firstHits: number;
  evaluations: number;
  branches: Record<Branch, number>;
  /** Rule matches by a rule after the first, where the order of the rules decides. */
  laterRules: number;
}

/** Value, reason, rule index and bucket; an absent field counts as null. */
const fields = (result: unknown): string => {
  const r = result as
    { value?: boolean; reason?: string; ruleIndex?: number; bucket?: number } | undefined;
  return JSON.stringify([r?.value, r?.reason, r?.ruleIndex ?? null, r?.bucket ?? null]);
};

const byKey = <T extends { key: string }>(items: Iterable<T>): T[] =>
  [...items].toSorted((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

/** One tenant, its SDK client on the first app, and the flags saved so far. */
class Subject {
  private saved = new Map<string, Flag>();

  private constructor(
    private readonly env: Environment,
    readonly tenantId: string,
    readonly client: FlagsClient,
    /** The snapshots the client refused, with the reason. */
    readonly refused: readonly SnapshotError[],
  ) {}

  static async start(env: Environment): Promise<Subject> {
    const tenantId = randomUUID();
    const sdkKey = `rff_sdk_${randomBytes(32).toString('base64url')}`;
    await env.admin.query(
      `INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'Agreement')`,
      [tenantId, `agreement-${tenantId}`],
    );
    await env.admin.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [tenantId, env.world.people.editorOfA.id],
    );
    await env.admin.query('INSERT INTO public.sdk_keys (tenant_id, key_hash) VALUES ($1, $2)', [
      tenantId,
      createHash('sha256').update(sdkKey).digest(),
    ]);
    const refused: SnapshotError[] = [];
    const client = new FlagsClient({
      url: env.apis[0]!.base,
      sdkKey,
      onError: (error) => {
        if (error instanceof SnapshotError) refused.push(error);
      },
    });
    return new Subject(env, tenantId, client, refused);
  }

  private async send(call: Call, through: number) {
    const reply = await this.env.send(this.env.world.people.editorOfA, call, through);
    if (reply.status !== 200 && reply.status !== 201) {
      throw new Error(`${call.method} ${call.path} answered ${reply.status}: ${reply.text}`);
    }
    return reply.body as { version: number; flag?: Flag };
  }

  /**
   * Makes the tenant's flags exactly settings, through app `through`, and returns the
   * version of the last write. The flags as saved are the settings with the salt the
   * server chose on creation, never what a reply says they are.
   */
  async save(settings: readonly FlagSettings[], through: number): Promise<number> {
    const path = `/tenants/${this.tenantId}/flags`;
    const next = new Map<string, Flag>();
    let version = 0;
    for (const key of this.saved.keys()) {
      if (!settings.some((flag) => flag.key === key)) {
        // eslint-disable-next-line no-await-in-loop -- one write after another
        ({ version } = await this.send({ method: 'DELETE', path: `${path}/${key}` }, through));
      }
    }
    for (const flag of settings) {
      const { key, ...rest } = flag;
      const before = this.saved.get(key);
      const call: Call =
        before === undefined
          ? { method: 'POST', path, body: flag }
          : { method: 'PUT', path: `${path}/${key}`, body: rest };
      // eslint-disable-next-line no-await-in-loop -- one write after another
      const body = await this.send(call, through);
      version = body.version;
      next.set(key, { ...flag, salt: before?.salt ?? body.flag?.salt ?? '' });
    }
    this.saved = next;
    return version;
  }

  /** Waits until the client holds version, or throws with what it refused. */
  async received(version: number): Promise<void> {
    try {
      await eventually(
        () => this.client.version === version || this.refused.length > 0,
        `the SDK at version ${version}`,
      );
    } catch {
      throw new Error(`the SDK did not reach version ${version}; it holds ${this.client.version}`);
    }
    const [refused] = this.refused;
    if (refused !== undefined) throw new Error(`the SDK refused a snapshot: ${refused.message}`);
  }

  get savedFlags(): Flag[] {
    return byKey(this.saved.values());
  }

  async evaluate(ctx: Context): Promise<{ version: number; results: EvaluationResult[] }> {
    const reply = await this.env.send(
      this.env.world.people.editorOfA,
      { method: 'POST', path: `/tenants/${this.tenantId}/evaluate`, body: ctx },
      1,
    );
    if (reply.status !== 200) throw new Error(`POST /evaluate answered ${reply.status}`);
    return reply.body as { version: number; results: EvaluationResult[] };
  }
}

function agreement(env: Environment, tally: Tally) {
  let subject: Subject | undefined;
  const cache = env.apis[1]!.app.get(FlagsCache);
  return {
    property: fc.asyncProperty(flagSet, contexts, via, async (settings, cases, through) => {
      subject ??= await Subject.start(env);
      tally.runs += 1;
      const version = await subject.save(settings, through);
      await subject.received(version);
      const saved = subject.savedFlags;
      if (!isDeepStrictEqual(subject.client.flags, saved)) {
        throw new Error(`the SDK holds flags other than those saved at version ${version}`);
      }
      for (const [index, ctx] of cases.entries()) {
        const misses = cache.misses;
        // eslint-disable-next-line no-await-in-loop -- one request at a time
        const answer = await subject.evaluate(ctx);
        tally.requests += 1;
        if (index === 0 && cache.misses === misses) tally.firstHits += 1;
        const keys = answer.results.map((result) => result.flagKey);
        const held = saved.map((flag) => flag.key);
        if (answer.version !== version || !isDeepStrictEqual(keys, held)) {
          throw new Error(
            `at version ${version}, POST /evaluate gives version ${answer.version} with flags ${keys.join(', ')} and the SDK holds ${held.join(', ')}`,
          );
        }
        for (const result of answer.results) {
          const local = subject.client.evaluate(result.flagKey, ctx);
          if (fields(local) !== fields(result)) {
            throw new Error(
              `at version ${version}, flag ${result.flagKey} for context ${JSON.stringify(ctx)}: POST /evaluate gives ${fields(result)} and the SDK ${fields(local)}`,
            );
          }
          tally.evaluations += 1;
          const branch: Branch =
            result.reason === 'rollout'
              ? result.value
                ? 'rollout-in'
                : 'rollout-out'
              : result.reason;
          tally.branches[branch] += 1;
          if (result.reason === 'rule' && result.ruleIndex > 0) tally.laterRules += 1;
        }
      }
    }),
    close: async () => {
      await subject?.client.close();
    },
  };
}

const newTally = (): Tally => ({
  runs: 0,
  requests: 0,
  firstHits: 0,
  evaluations: 0,
  branches: { disabled: 0, rule: 0, 'rollout-in': 0, 'rollout-out': 0 },
  laterRules: 0,
});

const PARAMS = { seed: AGREEMENT.seed, numRuns: AGREEMENT.numRuns, endOnFailure: true };

/** The message of the error that made the property fail on apps with these changes. */
async function failureOf(name: string, changes: readonly AppChanges[]): Promise<string> {
  const env = await startEnvironment(name, changes);
  const { property, close } = agreement(env, newTally());
  try {
    const details = await fc.check(property, PARAMS);
    if (!details.failed) return 'the property held';
    const error = details.errorInstance;
    return error instanceof Error ? error.message : String(error);
  } finally {
    await close();
    await env.close({ clearCache: true });
  }
}

/** Both apps read rows through a database that changes each row the way rewrite does. */
function rewrittenRows(rewrite: (row: Record<string, unknown>) => void): AppChanges[] {
  const override = (builder: TestingModuleBuilder) =>
    builder.overrideProvider(TenantDatabase).useFactory({
      factory: (pool: pg.Pool) => new RewritingDatabase(pool, rewrite),
      inject: [PG_POOL],
    });
  return [{ override }, { override }];
}

describe('agreement between the SDK and POST /evaluate', () => {
  it(
    `random flag sets saved through the API reach an SDK client as saved, and its evaluate() agrees with POST /evaluate on the other app at the same version ${label(AGREEMENT)}`,
    { timeout: 300_000 },
    async () => {
      const env = await startEnvironment('agreement', [{}, {}]);
      const tally = newTally();
      const { property, close } = agreement(env, tally);
      const cache = env.apis[1]!.app.get(FlagsCache);
      try {
        await fc.assert(property, PARAMS);
      } finally {
        await close();
        await env.close();
      }
      expect(tally.runs).toBe(AGREEMENT.numRuns);
      // A first app that cached nothing for the stream, or a cache that the apps do
      // not share, leaves the first request of every run a miss.
      expect(tally.firstHits, JSON.stringify(tally)).toBeGreaterThanOrEqual(tally.runs * 0.75);
      expect(cache.hits, JSON.stringify(tally)).toBeGreaterThanOrEqual(tally.requests / 2);
      for (const [branch, count] of Object.entries(tally.branches)) {
        expect(count / tally.evaluations, `${branch} in ${JSON.stringify(tally)}`).toBeGreaterThan(
          BRANCH_FLOOR,
        );
      }
      expect(tally.laterRules, JSON.stringify(tally)).toBeGreaterThan(0);
    },
  );

  it(
    `control: storage that loses the order of the rules fails the check that the SDK holds the flags as saved ${label(AGREEMENT)}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf(
        'agreeorder',
        rewrittenRows((row) => {
          if (Array.isArray(row.rules)) row.rules = row.rules.toReversed();
        }),
      );
      expect(message).toMatch(/^the SDK holds flags other than those saved at version \d+$/);
    },
  );

  it(
    `control: storage that returns the percentage as a string fails, because the SDK refuses the snapshot ${label(AGREEMENT)}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf(
        'agreestring',
        rewrittenRows((row) => {
          if (typeof row.rollout_bp === 'number') row.rollout_bp = String(row.rollout_bp);
        }),
      );
      expect(message).toMatch(
        /^the SDK refused a snapshot: flag \d+ is invalid: rolloutBasisPoints: must be an integer/,
      );
    },
  );

  it(
    `control: a second app that evaluates from a stale cache entry, one per tenant that a change never replaces, fails the comparison with the SDK ${label(AGREEMENT)}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf('agreestale', [
        {},
        { override: (builder) => withCache(builder, FirstEntryCache) },
      ]);
      expect(message).toMatch(/^at version \d+, .*POST \/evaluate gives .* and the SDK /);
    },
  );
});

/** A database whose query results pass through rewrite, row by row, before the API sees them. */
class RewritingDatabase extends TenantDatabase {
  constructor(
    pool: pg.Pool,
    private readonly rewrite: (row: Record<string, unknown>) => void,
  ) {
    super(pool);
  }

  override withTenant<T>(scope: TenantScope, fn: (client: TenantClient) => Promise<T>): Promise<T> {
    return super.withTenant(scope, (client) =>
      fn({
        query: async <R extends pg.QueryResultRow>(
          text: string | pg.QueryConfig,
          values?: unknown[],
        ) => {
          const result = await client.query<R>(text, values);
          for (const row of result.rows) this.rewrite(row as Record<string, unknown>);
          return result;
        },
      }),
    );
  }
}
