// Builds the conformance file conformance/evaluation-cases.json: flags, contexts
// and the result the reference evaluator gives for each. Core, SDK and API tests
// read the file and require the same results. The cases come from a seeded
// generator with no library dependency, so the file only changes when this script,
// the shared pools or the reference evaluator change.
//
//   npm run conformance:write --workspace @rff/core

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTRIBUTE_NAMES,
  ATTRIBUTE_VALUES,
  LONE_SURROGATE_KEYS,
  NON_ASCII_KEYS,
  nearMisses,
  sameAfterFolding,
} from '../support/pools.ts';
import {
  referenceBucket,
  referenceEvaluate,
  type ReferenceContext,
  type ReferenceEvaluation,
  type ReferenceFlag,
  type ReferenceRule,
} from './reference-evaluator.ts';

export const CONFORMANCE_SEED = 20261014;
export const RANDOM_CASES = 400;
export const BOUNDARY_FLAGS = 24;
export const conformancePath = fileURLToPath(
  new URL('../../conformance/evaluation-cases.json', import.meta.url),
);

export interface ConformanceCase {
  readonly id: number;
  readonly note: string;
  readonly flag: ReferenceFlag;
  readonly context: ReferenceContext;
  readonly expected: ReferenceEvaluation;
}

/** mulberry32: a small 32-bit generator, so the cases do not depend on any library's sampling. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  };
  const chance = (probability: number): boolean => next() < probability;
  return { int, pick, chance };
}

type Draw = ReturnType<typeof generator>;

const KEY_FIRST = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const KEY_REST = [...KEY_FIRST, '_', '-'];
const HEX = [...'0123456789abcdef'];
const PRINTABLE = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));

function text(draw: Draw, alphabet: readonly string[], length: number): string {
  return Array.from({ length }, () => draw.pick(alphabet)).join('');
}

function flagKey(draw: Draw): string {
  const length = draw.chance(0.05) ? 64 : draw.int(1, 24);
  return draw.pick(KEY_FIRST) + text(draw, KEY_REST, length - 1);
}

function userKey(draw: Draw): string {
  switch (draw.int(0, 5)) {
    case 0:
      return '';
    case 1:
      return `user-${draw.int(0, 1_000_000)}`;
    case 2:
      return text(draw, PRINTABLE, draw.int(1, 30));
    case 3:
      return draw.pick(NON_ASCII_KEYS);
    case 4:
      return draw.pick(LONE_SURROGATE_KEYS);
    default:
      return `${text(draw, HEX, 8)}-${text(draw, HEX, 4)}-4${text(draw, HEX, 3)}`;
  }
}

function attributeValue(draw: Draw): string {
  return draw.chance(0.85) ? draw.pick(ATTRIBUTE_VALUES) : text(draw, PRINTABLE, draw.int(0, 6));
}

function rule(draw: Draw): ReferenceRule {
  const attribute = draw.pick(ATTRIBUTE_NAMES);
  const serve = draw.chance(0.5);
  if (draw.chance(0.5)) {
    return { attribute, operator: 'equals', values: [draw.pick(ATTRIBUTE_VALUES)], serve };
  }
  const values = new Set<string>();
  const count = draw.int(1, 4);
  while (values.size < count) values.add(draw.pick(ATTRIBUTE_VALUES));
  return { attribute, operator: 'in', values: [...values], serve };
}

function basisPoints(draw: Draw): number {
  return draw.chance(0.3) ? draw.pick([0, 1, 9999, 10_000]) : draw.int(0, 10_000);
}

function flag(draw: Draw): ReferenceFlag {
  return {
    key: flagKey(draw),
    enabled: draw.chance(0.8),
    salt: text(draw, HEX, 16),
    rules: Array.from({ length: draw.int(0, 5) }, () => rule(draw)),
    rolloutBasisPoints: basisPoints(draw),
  };
}

/**
 * A context for a flag. Half the attribute values come from the values of a rule
 * on the same attribute, so rules match often. Some of the rest are rule values,
 * or near misses of them, from rules on a name that differs only in case,
 * surrounding spaces or normalization.
 */
function context(draw: Draw, forFlag: ReferenceFlag): ReferenceContext {
  const key = userKey(draw);
  if (draw.chance(0.25)) return { key };
  const entries: [string, string][] = [];
  const names = new Set<string>();
  const count = draw.int(0, 4);
  for (let i = 0; i < count; i++) {
    const name = draw.pick(ATTRIBUTE_NAMES);
    if (names.has(name)) continue;
    names.add(name);
    const ruleValues = forFlag.rules.filter((r) => r.attribute === name).flatMap((r) => r.values);
    const near = forFlag.rules
      .filter((r) => sameAfterFolding(r.attribute, name))
      .flatMap((r) => r.values.flatMap((value) => [value, ...nearMisses(value)]));
    let value: string;
    if (ruleValues.length > 0 && draw.chance(0.5)) value = draw.pick(ruleValues);
    else if (near.length > 0 && draw.chance(0.5)) value = draw.pick(near);
    else value = attributeValue(draw);
    entries.push([name, value]);
  }
  // Object.fromEntries defines "__proto__" as an own property instead of setting the prototype.
  return { key, attributes: Object.fromEntries(entries) };
}

/** The first `user-<n>` key whose bucket for the flag is `bucket`. */
function userWithBucket(forFlag: ReferenceFlag, bucket: number): string {
  for (let n = 0; ; n++) {
    const key = `user-${n}`;
    if (referenceBucket(forFlag.key, forFlag.salt, key) === bucket) return key;
  }
}

function rulesOnly(base: ReferenceFlag, rules: ReferenceRule[]): ReferenceFlag {
  return { ...base, enabled: true, rules, rolloutBasisPoints: 5000 };
}

export function generateConformanceCases(): ConformanceCase[] {
  const draw = generator(CONFORMANCE_SEED);
  const cases: ConformanceCase[] = [];
  const add = (note: string, caseFlag: ReferenceFlag, caseContext: ReferenceContext): void => {
    cases.push({
      id: cases.length + 1,
      note,
      flag: caseFlag,
      context: caseContext,
      expected: referenceEvaluate(caseFlag, caseContext),
    });
  };

  for (let i = 0; i < RANDOM_CASES; i++) {
    const randomFlag = flag(draw);
    add('random', randomFlag, context(draw, randomFlag));
  }

  for (let i = 0; i < BOUNDARY_FLAGS; i++) {
    const base: ReferenceFlag = { ...flag(draw), enabled: true, rules: [] };
    const user: ReferenceContext = { key: userKey(draw) };
    const bucket = referenceBucket(base.key, base.salt, user.key);
    const percentages: [string, number][] = [
      ['boundary: bucket - 1', bucket - 1],
      ['boundary: bucket', bucket],
      ['boundary: bucket + 1', bucket + 1],
      ['boundary: 0', 0],
      ['boundary: 10000', 10_000],
    ];
    for (const [note, rolloutBasisPoints] of percentages) {
      if (rolloutBasisPoints >= 0 && rolloutBasisPoints <= 10_000) {
        add(note, { ...base, rolloutBasisPoints }, user);
      }
    }
  }

  // The users whose buckets are 0 and 9999, each at the two percentages around
  // its bucket: 0 is out at 0 and in at 1, 9999 is out at 9999 and in at 10000.
  const edgeFlag: ReferenceFlag = { ...flag(draw), enabled: true, rules: [] };
  for (const [bucket, percentages] of [
    [0, [0, 1]],
    [9999, [9999, 10_000]],
  ] as const) {
    const key = userWithBucket(edgeFlag, bucket);
    for (const rolloutBasisPoints of percentages) {
      add(
        `edge: bucket ${bucket} at ${rolloutBasisPoints}`,
        { ...edgeFlag, rolloutBasisPoints },
        {
          key,
        },
      );
    }
  }

  for (const key of ['', ...NON_ASCII_KEYS, ...LONE_SURROGATE_KEYS]) {
    add(
      'user key: empty, non-ASCII or lone surrogate',
      { ...flag(draw), enabled: true, rules: [] },
      { key },
    );
  }

  const base = flag(draw);
  const us: ReferenceRule = {
    attribute: 'country',
    operator: 'equals',
    values: ['us'],
    serve: true,
  };
  const pro: ReferenceRule = {
    attribute: 'plan',
    operator: 'in',
    values: ['pro', 'free'],
    serve: false,
  };
  const both = { key: 'user-1', attributes: { country: 'us', plan: 'pro' } };
  add('rule: two rules match, the first wins', rulesOnly(base, [us, pro]), both);
  add('rule: two rules match, the first wins (order swapped)', rulesOnly(base, [pro, us]), both);
  add(
    'rule: first rule reads a missing attribute, second matches',
    rulesOnly(base, [
      { attribute: 'beta', operator: 'equals', values: ['true'], serve: false },
      us,
    ]),
    { key: 'user-2', attributes: { country: 'us' } },
  );
  add('rule: no rule matches, the rollout decides', rulesOnly(base, [us, pro]), {
    key: 'user-3',
    attributes: { country: 'gb', plan: 'team' },
  });
  add('rule: context without attributes, the rollout decides', rulesOnly(base, [us]), {
    key: 'user-4',
  });
  add(
    'rule: the empty string is a value that can match',
    rulesOnly(base, [{ attribute: 'plan', operator: 'equals', values: [''], serve: true }]),
    { key: 'user-5', attributes: { plan: '' } },
  );
  add(
    'rule: a missing attribute does not match the empty string',
    rulesOnly(base, [{ attribute: 'plan', operator: 'equals', values: [''], serve: true }]),
    { key: 'user-6', attributes: {} },
  );
  add(
    'rule: an attribute named __proto__ is an own property',
    rulesOnly(base, [{ attribute: '__proto__', operator: 'in', values: ['us'], serve: true }]),
    { key: 'user-7', attributes: Object.fromEntries([['__proto__', 'us']]) },
  );
  add(
    'rule: an inherited name such as constructor is not an attribute',
    rulesOnly(base, [{ attribute: 'constructor', operator: 'in', values: [''], serve: true }]),
    { key: 'user-8', attributes: { plan: 'pro' } },
  );
  add(
    'rule: non-ASCII attribute name and values',
    rulesOnly(base, [{ attribute: 'région', operator: 'in', values: ['ü', '日本'], serve: true }]),
    { key: 'user-9', attributes: { région: '日本' } },
  );
  add('rule: values compare with case: "US" does not match "us"', rulesOnly(base, [us]), {
    key: 'user-10',
    attributes: { country: 'US' },
  });
  add('rule: values compare with spaces: " us" does not match "us"', rulesOnly(base, [us]), {
    key: 'user-11',
    attributes: { country: ' us' },
  });
  add('rule: values compare with spaces: "us " does not match "us"', rulesOnly(base, [us]), {
    key: 'user-12',
    attributes: { country: 'us ' },
  });
  add(
    'rule: values compare as code units: u + U+0308 does not match ü (U+00FC)',
    rulesOnly(base, [{ attribute: 'région', operator: 'in', values: ['ü'], serve: true }]),
    { key: 'user-13', attributes: { région: 'u\u0308' } },
  );
  add(
    'rule: names compare with case: a rule on "Country" does not read "country"',
    rulesOnly(base, [{ ...us, attribute: 'Country' }]),
    { key: 'user-14', attributes: { country: 'us' } },
  );
  add('disabled: a matching rule is ignored', { ...rulesOnly(base, [us]), enabled: false }, both);

  return cases;
}

/** One case per line, so a change to one case is a one-line diff. */
export function serializeCases(cases: readonly ConformanceCase[]): string {
  return `[\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = generateConformanceCases();
  writeFileSync(conformancePath, serializeCases(cases));
  process.stdout.write(`wrote ${cases.length} cases to ${conformancePath}\n`);
}
