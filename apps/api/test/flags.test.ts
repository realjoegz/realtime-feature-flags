import { evaluate, type Flag, type Rule, validateContext, validateFlag } from '@rff/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLAGS_NOTIFIER, type FlagsChange, type FlagsNotifier } from '../src/flags/notifier.js';
import { inSequence } from './isolation/detectors.js';
import { type Call, type Environment, type Reply, startEnvironment } from './support/api.js';
import { label, runParams } from './support/fc-params.js';

// Flags, versions and evaluation through the API, as the editor of A.

/** Records each notification; can be told to throw, as a publisher that is down would. */
class RecordingNotifier implements FlagsNotifier {
  readonly calls: FlagsChange[] = [];
  onCall: (change: FlagsChange) => Promise<void> = async () => {};
  failing = false;

  async flagsChanged(change: FlagsChange): Promise<void> {
    this.calls.push(change);
    await this.onCall(change);
    if (this.failing) throw new Error('publisher is down');
  }
}

const notifier = new RecordingNotifier();
let env: Environment;
let flagsPath: string;

beforeAll(async () => {
  env = await startEnvironment('flags', {
    override: (builder) => builder.overrideProvider(FLAGS_NOTIFIER).useValue(notifier),
  });
  flagsPath = `/tenants/${env.world.fixture.tenantA}/flags`;
});

afterAll(async () => {
  await env?.close();
});

function asEditor(call: Call): Promise<Reply> {
  return env.send(env.world.people.editorOfA, call);
}

async function tenantVersion(tenantId = env.world.fixture.tenantA): Promise<number> {
  const { rows } = await env.admin.query<{ version: string }>(
    'SELECT version::text FROM public.tenants WHERE id = $1',
    [tenantId],
  );
  return Number(rows[0]?.version);
}

async function auditRows(): Promise<{ action: string; target: string; version: number | null }[]> {
  const { rows } = await env.admin.query<{
    action: string;
    target: string;
    version: string | null;
  }>(
    'SELECT action, target, version::text FROM public.audit_log WHERE tenant_id = $1 ORDER BY id',
    [env.world.fixture.tenantA],
  );
  return rows.map(({ action, target, version }) => ({
    action,
    target,
    version: version === null ? null : Number(version),
  }));
}

const salt = (reply: Reply): string => (reply.body as { flag: Flag }).flag.salt;

const newFlag = (key: string, rolloutBasisPoints = 0, rules: Rule[] = []) => ({
  key,
  enabled: true,
  rules,
  rolloutBasisPoints,
});

describe('flags', () => {
  it('the server sets a 16-hex-digit salt, refusing one in a POST body, and PUT keeps key and salt, refusing either', async () => {
    await env.world.seed(env.admin);
    const first = await asEditor({ method: 'POST', path: flagsPath, body: newFlag('salted-1') });
    const second = await asEditor({ method: 'POST', path: flagsPath, body: newFlag('salted-2') });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(salt(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(salt(second)).not.toBe(salt(first));

    const withSalt = await asEditor({
      method: 'POST',
      path: flagsPath,
      body: { ...newFlag('salted-3'), salt: '0123456789abcdef' },
    });
    expect(withSalt.status).toBe(400);
    expect(withSalt.body).toMatchObject({ errors: ['salt: is set by the server'] });

    const put = (body: unknown) => asEditor({ method: 'PUT', path: `${flagsPath}/salted-1`, body });
    // Two rules that both match plan pro and serve opposite values: stored in another
    // order, they would answer pro users the other way.
    const settings = {
      enabled: false,
      rules: [
        { attribute: 'plan', operator: 'in', values: ['pro', 'team'], serve: true },
        { attribute: 'plan', operator: 'equals', values: ['pro'], serve: false },
      ],
      rolloutBasisPoints: 9000,
    };
    expect((await put({ ...settings, salt: '0123456789abcdef' })).body).toMatchObject({
      errors: ['salt: is set by the server and never changes'],
    });
    expect((await put({ ...settings, key: 'renamed' })).body).toMatchObject({
      errors: ['key: is set by the path'],
    });
    const updated = await put(settings);
    expect(updated.status).toBe(200);
    expect((updated.body as { flag: Flag }).flag).toEqual({
      key: 'salted-1',
      salt: salt(first),
      ...settings,
    });
    const read = await asEditor({ method: 'GET', path: `${flagsPath}/salted-1` });
    expect(read.body).toEqual({ key: 'salted-1', salt: salt(first), ...settings });
  });

  it('invalid flags and contexts get 400 and change nothing', async () => {
    await env.world.seed(env.admin);
    const version = await tenantVersion();
    const audit = await auditRows();
    const badFlags: unknown[] = [
      { ...newFlag('Bad Key') },
      { ...newFlag('ok'), rolloutBasisPoints: 10001 },
      { ...newFlag('ok'), rolloutBasisPoints: 1.5 },
      {
        ...newFlag('ok'),
        rules: [{ attribute: 'plan', operator: 'equals', values: [], serve: true }],
      },
      {
        ...newFlag('ok'),
        rules: [{ attribute: 'plan', operator: 'like', values: ['a'], serve: true }],
      },
      { ...newFlag('ok'), extra: true },
      { key: 'ok' },
      [newFlag('ok')],
    ];
    const replies = await inSequence(badFlags, (body) =>
      asEditor({ method: 'POST', path: flagsPath, body }),
    );
    expect(replies.map((reply) => reply.status)).toEqual(badFlags.map(() => 400));
    replies.forEach((reply, index) => {
      const body = badFlags[index];
      const expected =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? validateFlag({ ...body, salt: '0'.repeat(16) })
          : { ok: false as const, errors: ['flag: must be an object'] };
      expect(expected.ok).toBe(false);
      expect(reply.body).toEqual({
        statusCode: 400,
        message: 'invalid flag',
        errors: expected.ok ? [] : expected.errors,
      });
    });

    // PUT takes the settings without the key, which comes from the path.
    const checkoutPath = `${flagsPath}/checkout`;
    const checkoutBefore = await asEditor({ method: 'GET', path: checkoutPath });
    const settings = { enabled: true, rules: [], rolloutBasisPoints: 100 };
    const badSettings: unknown[] = [
      { ...settings, rolloutBasisPoints: 10001 },
      { ...settings, rolloutBasisPoints: -1 },
      { ...settings, enabled: 'yes' },
      { ...settings, rules: {} },
      {
        ...settings,
        rules: [{ attribute: 'plan', operator: 'equals', values: ['a', 'b'], serve: true }],
      },
      {
        ...settings,
        rules: [{ attribute: 'plan', operator: 'like', values: ['a'], serve: true }],
      },
      { ...settings, extra: true },
      { enabled: true },
      [settings],
    ];
    const putReplies = await inSequence(badSettings, (body) =>
      asEditor({ method: 'PUT', path: checkoutPath, body }),
    );
    expect(putReplies.map((reply) => reply.body)).toEqual(
      badSettings.map((body) => {
        const expected =
          typeof body === 'object' && body !== null && !Array.isArray(body)
            ? validateFlag({ ...body, key: 'checkout', salt: '0'.repeat(16) })
            : { ok: false as const, errors: ['flag: must be an object'] };
        return {
          statusCode: 400,
          message: 'invalid flag',
          errors: expected.ok ? ['expected validateFlag to refuse this'] : expected.errors,
        };
      }),
    );
    expect((await asEditor({ method: 'GET', path: checkoutPath })).body).toEqual(
      checkoutBefore.body,
    );

    const badContexts: unknown[] = [{}, { key: 1 }, { key: 'u', attributes: { plan: 2 } }, []];
    const evaluated = await inSequence(badContexts, (body) =>
      asEditor({ method: 'POST', path: `/tenants/${env.world.fixture.tenantA}/evaluate`, body }),
    );
    expect(evaluated.map((reply) => reply.body)).toEqual(
      badContexts.map((body) => {
        const result = validateContext(body);
        return {
          statusCode: 400,
          message: 'invalid context',
          errors: result.ok ? [] : result.errors,
        };
      }),
    );
    expect(await tenantVersion()).toBe(version);
    expect(await auditRows()).toEqual(audit);
  });

  it('a duplicate key gives 409 and a missing or impossible key 404, with no version, audit row or notification', async () => {
    await env.world.seed(env.admin);
    const version = await tenantVersion();
    const audit = await auditRows();
    const calls = notifier.calls.length;
    const settings = { enabled: true, rules: [], rolloutBasisPoints: 1 };
    const replies = await inSequence(
      [
        { method: 'POST', path: flagsPath, body: newFlag('checkout') },
        { method: 'PUT', path: `${flagsPath}/missing`, body: settings },
        { method: 'DELETE', path: `${flagsPath}/missing` },
        { method: 'GET', path: `${flagsPath}/missing` },
        { method: 'PUT', path: `${flagsPath}/Not-A-Key`, body: settings },
        { method: 'GET', path: `${flagsPath}/Not-A-Key` },
      ] satisfies Call[],
      asEditor,
    );
    expect(replies.map((reply) => reply.status)).toEqual([409, 404, 404, 404, 404, 404]);
    expect(new Set(replies.slice(1).map((reply) => reply.text)).size).toBe(1);
    expect(await tenantVersion()).toBe(version);
    expect(await auditRows()).toEqual(audit);
    expect(notifier.calls.length).toBe(calls);
  });

  it('each write raises the version by one, audits it and notifies it after COMMIT, also after a failed notification', async () => {
    await env.world.seed(env.admin);
    const { tenantA } = env.world.fixture;
    const start = await tenantVersion();
    const seen: { version: number; committed: number; flag: string | null }[] = [];
    notifier.calls.length = 0;
    notifier.onCall = async (change) => {
      // Read on another connection: only committed rows are visible there.
      const { rows } = await env.admin.query<{ version: string; flag: string | null }>(
        `SELECT t.version::text,
                (SELECT f.rollout_bp::text FROM public.flags f
                 WHERE f.tenant_id = t.id AND f.key = 'versioned') AS flag
         FROM public.tenants t WHERE t.id = $1`,
        [change.tenantId],
      );
      seen.push({
        version: change.version,
        committed: Number(rows[0]?.version),
        flag: rows[0]?.flag ?? null,
      });
    };
    try {
      const created = await asEditor({
        method: 'POST',
        path: flagsPath,
        body: newFlag('versioned', 10),
      });
      notifier.failing = true;
      const updated = await asEditor({
        method: 'PUT',
        path: `${flagsPath}/versioned`,
        body: { enabled: true, rules: [], rolloutBasisPoints: 20 },
      });
      notifier.failing = false;
      const removed = await asEditor({ method: 'DELETE', path: `${flagsPath}/versioned` });
      expect([created.status, updated.status, removed.status]).toEqual([201, 200, 200]);
      const versions = [created, updated, removed].map(
        (reply) => (reply.body as { version: number }).version,
      );
      expect(versions).toEqual([start + 1, start + 2, start + 3]);
      expect(notifier.calls).toEqual(versions.map((version) => ({ tenantId: tenantA, version })));
      expect(seen).toEqual([
        { version: start + 1, committed: start + 1, flag: '10' },
        { version: start + 2, committed: start + 2, flag: '20' },
        { version: start + 3, committed: start + 3, flag: null },
      ]);
      expect((await auditRows()).slice(-3)).toEqual([
        { action: 'flag.create', target: 'versioned', version: start + 1 },
        { action: 'flag.update', target: 'versioned', version: start + 2 },
        { action: 'flag.delete', target: 'versioned', version: start + 3 },
      ]);
    } finally {
      notifier.onCall = async () => {};
      notifier.failing = false;
    }
  });

  it('concurrent writes get consecutive versions and the flag ends as the highest version left it', async () => {
    await env.world.seed(env.admin);
    const start = await tenantVersion();
    const writes = Array.from({ length: 12 }, (_, index) => index + 1);
    const replies = await Promise.all(
      writes.map((rollout) =>
        asEditor({
          method: 'PUT',
          path: `${flagsPath}/checkout`,
          body: { enabled: true, rules: [], rolloutBasisPoints: rollout },
        }),
      ),
    );
    const results = replies.map((reply) => reply.body as { version: number; flag: Flag });
    expect(results.map((result) => result.version).toSorted((x, y) => x - y)).toEqual(
      writes.map((index) => start + index),
    );
    const last = results.reduce((x, y) => (y.version > x.version ? y : x));
    const read = await asEditor({ method: 'GET', path: `${flagsPath}/checkout` });
    expect(read.body).toEqual(last.flag);
    expect(await tenantVersion()).toBe(start + writes.length);
    // audit_log ids follow commit order here, because the version bump makes the
    // writers of one tenant take turns.
    const audit = (await auditRows()).filter((row) => (row.version ?? 0) > start);
    expect(audit.map((row) => row.version)).toEqual(writes.map((index) => start + index));
  });
});

describe('POST /evaluate', () => {
  it("returns evaluate()'s results for the flags of the version it returns", async () => {
    await env.world.seed(env.admin);
    const evaluatePath = `/tenants/${env.world.fixture.tenantA}/evaluate`;
    const contexts = [
      { key: 'user-1' },
      { key: 'user-2', attributes: { country: 'NL' } },
      { key: '', attributes: { plan: env.world.fixture.canaries.get('public.flags.rules') ?? '' } },
      { key: 'ünïcödé', attributes: { plan: 'pro', country: 'BE' } },
    ];
    const listed = (await asEditor({ method: 'GET', path: flagsPath })).body as {
      version: number;
      flags: Flag[];
    };
    const replies = await inSequence(contexts, (body) =>
      asEditor({ method: 'POST', path: evaluatePath, body }),
    );
    expect(replies.map((reply) => reply.body)).toEqual(
      contexts.map((context) => ({
        version: listed.version,
        results: listed.flags.map((flag) =>
          Object.assign({ flagKey: flag.key }, evaluate(flag, context)),
        ),
      })),
    );
    // Every branch of evaluate() shows up.
    const reasons = new Set(
      replies.flatMap((reply) =>
        (reply.body as { results: { reason: string }[] }).results.map((r) => r.reason),
      ),
    );
    expect([...reasons].toSorted()).toEqual(['disabled', 'rollout', 'rule']);
  });

  it('during writes, each answer matches its version', async () => {
    await env.world.seed(env.admin);
    const { tenantA } = env.world.fixture;
    const start = await tenantVersion();
    // Each write flips checkout between nobody (0) and everybody (10000), so the value
    // for any user tells which version's flag was evaluated.
    const stateAt = new Map<number, boolean>();
    const writer = inSequence(
      Array.from({ length: 20 }, (_, index) => index),
      async (index) => {
        const reply = await asEditor({
          method: 'PUT',
          path: `${flagsPath}/checkout`,
          body: { enabled: true, rules: [], rolloutBasisPoints: index % 2 === 0 ? 10000 : 0 },
        });
        const { version, flag } = reply.body as { version: number; flag: Flag };
        stateAt.set(version, flag.rolloutBasisPoints === 10000);
      },
    );
    const answers: { version: number; value: boolean }[] = [];
    const progress = { writing: true };
    const writes = writer.finally(() => {
      progress.writing = false;
    });
    while (progress.writing) {
      // eslint-disable-next-line no-await-in-loop -- one evaluation after another while the writes run
      const reply = await asEditor({
        method: 'POST',
        path: `/tenants/${tenantA}/evaluate`,
        body: { key: 'reader' },
      });
      const body = reply.body as {
        version: number;
        results: { flagKey: string; value: boolean }[];
      };
      const checkout = body.results.find((result) => result.flagKey === 'checkout');
      answers.push({ version: body.version, value: checkout?.value ?? false });
    }
    await writes;
    const mismatches = answers.filter(
      (answer) => answer.version > start && stateAt.get(answer.version) !== answer.value,
    );
    expect(mismatches).toEqual([]);
    expect(answers.filter((answer) => answer.version > start).length).toBeGreaterThan(0);
  });
});

// The API-level rollout property: what P2 in packages/core/test/rollout.test.ts
// states for evaluate(), checked through the routes and the database. The salt
// comes from the server, so the seed fixes the percentages, rules and users, and the
// property must hold for whatever salt the server draws.
const ROLLOUT = runParams(20);
const USERS = 25;

// Rules on plan whose values overlap ("in" pro and team, "equals" pro), so a user often
// matches two rules that serve different values and the rule order decides the answer.
const rules = fc.array(
  fc.oneof(
    fc.record({
      attribute: fc.constant('plan'),
      operator: fc.constant('equals' as const),
      values: fc.constantFrom(['pro'], ['free']),
      serve: fc.boolean(),
    }),
    fc.record({
      attribute: fc.constant('plan'),
      operator: fc.constant('in' as const),
      values: fc.constantFrom(['pro', 'team'], ['free', 'pro']),
      serve: fc.boolean(),
    }),
  ),
  { maxLength: 3 },
);
const users = fc.uniqueArray(
  fc.record({ key: fc.string({ maxLength: 12 }), plan: fc.constantFrom('pro', 'free', 'team') }),
  { minLength: USERS, maxLength: USERS, selector: (user) => user.key },
);
const percentages = fc
  .tuple(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 }))
  .map(([a, b]): readonly [number, number] => (a <= b ? [a, b] : [b, a]));

describe('rollout through the API', () => {
  it(`a PUT raising only the percentage keeps every user in, with bucket, salt and rule order ${label(ROLLOUT)}`, async () => {
    await env.world.seed(env.admin);
    const evaluatePath = `/tenants/${env.world.fixture.tenantA}/evaluate`;
    let run = 0;
    const resultsFor = async (key: string, people: { key: string; plan: string }[]) =>
      inSequence(people, async (user) => {
        const reply = await asEditor({
          method: 'POST',
          path: evaluatePath,
          body: { key: user.key, attributes: { plan: user.plan } },
        });
        const { results } = reply.body as {
          results: { flagKey: string; value: boolean; bucket?: number }[];
        };
        const result = results.find((candidate) => candidate.flagKey === key);
        if (result === undefined) throw new Error(`no result for ${key}`);
        return result;
      });
    await fc.assert(
      fc.asyncProperty(percentages, rules, users, async ([p1, p2], flagRules, people) => {
        run += 1;
        const key = `rollout-${run}`;
        const created = await asEditor({
          method: 'POST',
          path: flagsPath,
          body: newFlag(key, p1, flagRules),
        });
        const createdSalt = salt(created);
        const before = await resultsFor(key, people);
        const raised = await asEditor({
          method: 'PUT',
          path: `${flagsPath}/${key}`,
          body: { enabled: true, rules: flagRules, rolloutBasisPoints: p2 },
        });
        const after = await resultsFor(key, people);
        const stored = (await asEditor({ method: 'GET', path: `${flagsPath}/${key}` }))
          .body as Flag;
        await asEditor({ method: 'DELETE', path: `${flagsPath}/${key}` });
        expect([created.status, raised.status]).toEqual([201, 200]);
        // The flag holds exactly what the PUT sent, rules in their order, and the salt
        // it was created with.
        const expected = {
          key,
          enabled: true,
          salt: createdSalt,
          rules: flagRules,
          rolloutBasisPoints: p2,
        };
        expect(stored).toEqual(expected);
        expect((raised.body as { flag: Flag }).flag).toEqual(expected);
        expect(salt(raised)).toBe(createdSalt);
        const dropped = people.filter((_, index) => before[index]?.value && !after[index]?.value);
        expect(dropped).toEqual([]);
        expect(after.map((result) => result.bucket)).toEqual(before.map((result) => result.bucket));
      }),
      // Each run is about 50 requests, so a failure is reported as found, unshrunk,
      // instead of shrinking past the test timeout.
      { seed: ROLLOUT.seed, numRuns: ROLLOUT.numRuns, endOnFailure: true },
    );
  });
});
