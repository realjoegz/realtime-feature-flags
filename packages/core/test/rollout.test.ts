// Rollout properties P1 to P5. Each property is a function of the evaluator under
// test: it must hold for src/ and be falsified for the committed broken
// evaluators in test/controls/.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { evaluate, type Context, type Flag } from '../src/index.ts';
import {
  constantHash,
  createResaltOnLowering,
  evaluatorWith,
  lessOrEqual,
  percentageInHashInput,
  randomBucket,
  type Evaluate,
} from './controls/broken-evaluators.ts';
import { referenceBucket } from './reference/reference-evaluator.ts';
import * as arb from './support/arbitraries.ts';
import { sameEvaluation } from './support/compare.ts';
import { label, runParams, type RunParams } from './support/fc-params.ts';
import { usersAtTheEnds } from './support/edges.ts';
import { ATTRIBUTE_NAMES } from './support/pools.ts';

function falsified<T>(property: fc.IProperty<T>, params: RunParams, examples?: T[]): boolean {
  return fc.check(property, { ...params, endOnFailure: true, ...(examples ? { examples } : {}) })
    .failed;
}

function withBasisPoints(flag: Flag, rolloutBasisPoints: number): Flag {
  return { ...flag, rolloutBasisPoints };
}

const ordered = fc
  .tuple(arb.basisPoints, arb.basisPoints)
  .map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a]));

const contexts = fc.array(arb.context, { minLength: 1, maxLength: 20 });

// P1 ------------------------------------------------------------------------

const P1 = runParams(500);

const otherAttributes = fc.dictionary(
  fc.oneof(
    fc.constantFrom(...ATTRIBUTE_NAMES),
    fc.string({ minLength: 1, maxLength: 8 }).map((name) => `x-${name}`),
  ),
  fc.string({ maxLength: 8 }),
  { maxKeys: 4 },
);

/**
 * The same flag and context give the same result after other flags are evaluated,
 * from a second module instance, and with extra attributes that no rule reads.
 */
function p1Property(first: Evaluate, second: Evaluate) {
  return fc.property(
    arb.flag,
    arb.context,
    fc.array(arb.flag, { maxLength: 4 }),
    otherAttributes,
    (target, context, others, extra) => {
      const expected = first(target, context);
      for (const other of others) first(other, context);
      const again = first(target, context);
      const fromSecondInstance = second(target, context);

      const present = context.attributes ?? {};
      const additions = arb
        .unreferencedAttributes(target, extra)
        .filter(([name]) => !Object.hasOwn(present, name));
      const widened: Context = {
        key: context.key,
        attributes: Object.fromEntries([...Object.entries(present), ...additions]),
      };
      const withOtherAttributes = first(target, widened);

      return (
        sameEvaluation(expected, again) &&
        sameEvaluation(expected, fromSecondInstance) &&
        sameEvaluation(expected, withOtherAttributes)
      );
    },
  );
}

/** Loads a module twice with the module registry cleared in between: two instances. */
async function twoInstances(
  load: () => Promise<{ evaluate: Evaluate }>,
): Promise<[Evaluate, Evaluate]> {
  vi.resetModules();
  const first = await load();
  vi.resetModules();
  const second = await load();
  return [first.evaluate, second.evaluate];
}

it(`P1 a result depends only on the flag, the user key and the attributes its rules read ${label(P1)}`, async () => {
  const [first, second] = await twoInstances(() => import('../src/index.ts'));
  expect(first).not.toBe(second);
  fc.assert(p1Property(first, second), P1);
});

it(`P1 control: a Math.random bucket is falsified ${label(P1)}`, () => {
  expect(falsified(p1Property(randomBucket, randomBucket), P1)).toBe(true);
});

it(`P1 control: a per-instance salt is falsified ${label(P1)}`, async () => {
  const [first, second] = await twoInstances(() => import('./controls/per-instance-salt.ts'));
  expect(first).not.toBe(second);
  expect(falsified(p1Property(first, second), P1)).toBe(true);
});

const PROCESS = runParams(300);
const childScript = fileURLToPath(new URL('./support/evaluate-in-child.ts', import.meta.url));
const coreModule = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const perInstanceSaltModule = fileURLToPath(
  new URL('./controls/per-instance-salt.ts', import.meta.url),
);

/** Evaluates sampled cases here and in a fresh Node process; returns how many differ. */
function mismatchesAcrossProcesses(modulePath: string, here: Evaluate): number {
  const cases = fc.sample(fc.tuple(arb.flag, arb.context), PROCESS);
  const child = spawnSync(process.execPath, [childScript, modulePath], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(`child process failed: ${child.stderr}`);
  const there = JSON.parse(child.stdout) as unknown[];
  expect(there).toHaveLength(cases.length);
  return cases.filter(
    ([flag, context], index) => !sameEvaluation(here(flag, context), there[index]),
  ).length;
}

it(`P1 a second Node process gives the same results ${label(PROCESS, 'cases')}`, () => {
  expect(mismatchesAcrossProcesses(coreModule, evaluate)).toBe(0);
});

it(`P1 control: a per-process salt differs in a second process ${label(PROCESS, 'cases')}`, async () => {
  const control = (await import('./controls/per-instance-salt.ts')) as { evaluate: Evaluate };
  expect(mismatchesAcrossProcesses(perInstanceSaltModule, control.evaluate)).toBeGreaterThan(0);
});

// P2 ------------------------------------------------------------------------

const P2 = runParams(1000);

function p2Property(subject: Evaluate) {
  return fc.property(arb.enabledFlag, contexts, ordered, (flag, users, [low, high]) =>
    users.every(
      (user) =>
        !subject(withBasisPoints(flag, low), user).value ||
        subject(withBasisPoints(flag, high), user).value,
    ),
  );
}

it(`P2 raising the percentage only adds users ${label(P2)}`, () => {
  fc.assert(p2Property(evaluate), P2);
});

it(`P2 control: the percentage mixed into the hash input is falsified ${label(P2)}`, () => {
  expect(falsified(p2Property(percentageInHashInput), P2)).toBe(true);
});

// P3 ------------------------------------------------------------------------

const P3 = runParams(1000);

const ends = usersAtTheEnds();

/** The users at buckets 0 and 9999, each at its bucket - 1, bucket and bucket + 1. */
const endsAtTheBoundary: [Flag, string, number][] = ends.flatMap(([flag, user]) =>
  [-1, 0, 1].map((offset): [Flag, string, number] => [flag, user.key, offset]),
);

function p3EndsProperty(subject: Evaluate) {
  return fc.property(arb.enabledFlag, arb.context, (flag, user) => {
    const atZero = subject(withBasisPoints(flag, 0), user);
    const atMax = subject(withBasisPoints(flag, 10_000), user);
    return (
      (atZero.reason !== 'rollout' || !atZero.value) && (atMax.reason !== 'rollout' || atMax.value)
    );
  });
}

function p3BoundaryProperty(subject: Evaluate) {
  return fc.property(
    arb.enabledFlag,
    arb.userKey,
    fc.integer({ min: -1, max: 1 }),
    (flag, key, offset) => {
      const bucket = referenceBucket(flag.key, flag.salt, key);
      const basisPoints = Math.min(10_000, Math.max(0, bucket + offset));
      const result = subject({ ...flag, rules: [], rolloutBasisPoints: basisPoints }, { key });
      return result.reason === 'rollout' && result.value === bucket < basisPoints;
    },
  );
}

it(`P3 by rollout, 0 basis points let nobody in and 10000 everybody ${label(P3)}`, () => {
  fc.assert(p3EndsProperty(evaluate), { ...P3, examples: ends });
});

it(`P3 a user is in exactly when its bucket is below the percentage ${label(P3)}`, () => {
  fc.assert(p3BoundaryProperty(evaluate), { ...P3, examples: endsAtTheBoundary });
});

it(`P3 control: less-or-equal for less-than is falsified ${label(P3)}`, () => {
  expect(falsified(p3EndsProperty(lessOrEqual), P3, ends)).toBe(true);
  expect(falsified(p3BoundaryProperty(lessOrEqual), P3, endsAtTheBoundary)).toBe(true);
});

// P4 ------------------------------------------------------------------------

const P4 = runParams(500);

function p4Property(createSubject: () => Evaluate) {
  return fc.property(arb.enabledFlag, contexts, ordered, (flag, users, [low, high]) => {
    const subject = createSubject();
    const at = (basisPoints: number) =>
      users.map((user) => subject(withBasisPoints(flag, basisPoints), user).value);
    const before = at(high);
    const lowered = at(low);
    const restored = at(high);
    return (
      before.every((value, index) => value === restored[index]) &&
      lowered.every((value, index) => !value || before[index] === true)
    );
  });
}

it(`P4 lowering then raising the percentage restores the same users ${label(P4)}`, () => {
  fc.assert(
    p4Property(() => evaluate),
    P4,
  );
});

it(`P4 control: a salt regenerated on lowering is falsified ${label(P4)}`, () => {
  expect(falsified(p4Property(createResaltOnLowering), P4)).toBe(true);
});

// P5 ------------------------------------------------------------------------

const P5 = runParams(6);
const P5_USERS = 100_000;
const P5_PERCENTAGES = [1, 100, 1000, 2500, 5000, 9000, 9999] as const;
const P5_SIGMAS = 5;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type KeyStyle = 'sequential' | 'hex' | 'uuid';

/** 100,000 user keys in one of three shapes, drawn from a seeded generator. */
function userKeys(style: KeyStyle, seed: number): string[] {
  const random = mulberry32(seed);
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('');
  const offset = Math.floor(random() * 1_000_000);
  return Array.from({ length: P5_USERS }, (_, n) => {
    if (style === 'sequential') return `user-${offset + n}`;
    if (style === 'hex') return `${hex(16)}${n.toString(36)}`;
    return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  });
}

function p5Property(subject: Evaluate) {
  return fc.property(
    arb.flagKey,
    arb.salt,
    fc.constantFrom<KeyStyle>('sequential', 'hex', 'uuid'),
    fc.integer(),
    (key, salt, style, seed) => {
      const keys = userKeys(style, seed);
      return P5_PERCENTAGES.every((basisPoints) => {
        const flag: Flag = { key, enabled: true, salt, rules: [], rolloutBasisPoints: basisPoints };
        let inRollout = 0;
        for (const userKey of keys) if (subject(flag, { key: userKey }).value) inRollout++;
        const p = basisPoints / 10_000;
        const sigma = Math.sqrt((p * (1 - p)) / keys.length);
        return Math.abs(inRollout / keys.length - p) <= P5_SIGMAS * sigma;
      });
    },
  );
}

it(`P5 the rollout share is within 5 sigma ${label(P5)}`, { timeout: 60_000 }, () => {
  fc.assert(p5Property(evaluate), P5);
});

it(`P5 control: a constant hash is falsified ${label(P5)}`, { timeout: 60_000 }, () => {
  expect(falsified(p5Property(constantHash), P5)).toBe(true);
});

// Control scaffold ------------------------------------------------------------

// Every control above is the scaffold in test/controls/broken-evaluators.ts with
// one part replaced. With no part replaced the scaffold must pass every property,
// so a control can only be falsified by the part it replaces.
it(
  `control scaffold: with no part replaced it passes P1 to P5 (seed ${P1.seed})`,
  { timeout: 60_000 },
  () => {
    fc.assert(p1Property(evaluatorWith({}), evaluatorWith({})), P1);
    fc.assert(p2Property(evaluatorWith({})), P2);
    fc.assert(p3EndsProperty(evaluatorWith({})), { ...P3, examples: ends });
    fc.assert(p3BoundaryProperty(evaluatorWith({})), { ...P3, examples: endsAtTheBoundary });
    fc.assert(
      p4Property(() => evaluatorWith({})),
      P4,
    );
    fc.assert(
      p4Property(() => createResaltOnLowering(false)),
      P4,
    );
    fc.assert(p5Property(evaluatorWith({})), P5);
  },
);
