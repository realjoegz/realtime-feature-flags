// The committed conformance file: flags, contexts and the results the reference
// evaluator gives. The SDK and API tests read the same file.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { evaluate, validateContext, validateFlag, type Context, type Flag } from '../src/index.ts';
import { referenceEvaluate } from './reference/reference-evaluator.ts';
import {
  conformancePath,
  generateConformanceCases,
  serializeCases,
  type ConformanceCase,
} from './reference/write-conformance.ts';
import { branchOf, fieldsOf } from './support/compare.ts';
import {
  LONE_SURROGATE_KEYS,
  NON_ASCII_KEYS,
  nearMisses,
  sameAfterFolding,
} from './support/pools.ts';

const committedText = readFileSync(conformancePath, 'utf8');
const cases = JSON.parse(committedText) as (ConformanceCase & { flag: Flag; context: Context })[];

it('the conformance file is what the reference evaluator generates from seed 20261014', () => {
  expect(committedText).toBe(serializeCases(generateConformanceCases()));
  for (const entry of cases) {
    expect(fieldsOf(referenceEvaluate(entry.flag, entry.context)), `case ${entry.id}`).toEqual(
      fieldsOf(entry.expected),
    );
  }
});

it('every flag and context in the conformance file is valid', () => {
  for (const entry of cases) {
    expect(validateFlag(entry.flag), `case ${entry.id} flag`).toMatchObject({ ok: true });
    expect(validateContext(entry.context), `case ${entry.id} context`).toMatchObject({ ok: true });
  }
});

it('evaluate() gives the expected value, reason, rule index and bucket for all 551 conformance cases', () => {
  expect(cases).toHaveLength(551);
  for (const entry of cases) {
    expect(
      fieldsOf(evaluate(entry.flag, entry.context)),
      `case ${entry.id}: ${entry.note}`,
    ).toEqual(fieldsOf(entry.expected));
  }
});

function count(predicate: (entry: ConformanceCase) => boolean): number {
  return cases.filter(predicate).length;
}

/** Rollout cases whose percentage is the bucket plus an offset, with the given value. */
function atBucket(offset: number, value: boolean): number {
  return count(
    (entry) =>
      entry.expected.reason === 'rollout' &&
      entry.flag.rolloutBasisPoints === entry.expected.bucket + offset &&
      entry.expected.value === value,
  );
}

function rolloutCasesAt(basisPoints: number): number {
  return count(
    (entry) => entry.expected.reason === 'rollout' && entry.flag.rolloutBasisPoints === basisPoints,
  );
}

/** Cases with a context value one near miss away from a value of a rule on the same attribute. */
function nearMissValues(): number {
  return count((entry) => {
    const attributes = entry.context.attributes ?? {};
    return entry.flag.rules.some(
      (rule) =>
        Object.hasOwn(attributes, rule.attribute) &&
        rule.values.some((value) => nearMisses(value).includes(attributes[rule.attribute] ?? '')),
    );
  });
}

/** Cases where a rule's value sits under a name that differs from the rule's only in case, spaces or normalization. */
function nearMissNames(): number {
  return count((entry) => {
    const attributes = entry.context.attributes ?? {};
    return entry.flag.rules.some(
      (rule) =>
        !Object.hasOwn(attributes, rule.attribute) &&
        Object.entries(attributes).some(
          ([name, value]) =>
            name !== rule.attribute &&
            sameAfterFolding(name, rule.attribute) &&
            rule.values.includes(value),
        ),
    );
  });
}

it('the conformance file covers every branch, both sides of each boundary, buckets 0 and 9999, near-miss names and values, and non-ASCII keys', () => {
  const branches = new Map<string, number>();
  for (const entry of cases) {
    const branch = branchOf(entry.expected);
    const key = branch === 'rule' ? `rule-${entry.expected.value}` : branch;
    branches.set(key, (branches.get(key) ?? 0) + 1);
  }
  for (const branch of ['disabled', 'rule-true', 'rule-false', 'rollout-in', 'rollout-out']) {
    expect(branches.get(branch) ?? 0, branch).toBeGreaterThanOrEqual(20);
  }

  expect(atBucket(0, false), 'percentage equal to the bucket is out').toBeGreaterThanOrEqual(20);
  expect(atBucket(1, true), 'percentage one above the bucket is in').toBeGreaterThanOrEqual(20);

  expect(rolloutCasesAt(0)).toBeGreaterThanOrEqual(20);
  expect(rolloutCasesAt(10_000)).toBeGreaterThanOrEqual(20);

  const edges = [
    [0, 0, false],
    [0, 1, true],
    [9999, 9999, false],
    [9999, 10_000, true],
  ] as const;
  for (const [bucket, basisPoints, value] of edges) {
    expect(
      count(
        (entry) =>
          entry.expected.reason === 'rollout' &&
          entry.expected.bucket === bucket &&
          entry.flag.rolloutBasisPoints === basisPoints &&
          entry.expected.value === value,
      ),
      `bucket ${bucket} at ${basisPoints} basis points`,
    ).toBeGreaterThanOrEqual(1);
  }

  expect(nearMissValues(), 'near-miss values').toBeGreaterThanOrEqual(10);
  expect(nearMissNames(), 'near-miss names').toBeGreaterThanOrEqual(10);

  const special: readonly string[] = ['', ...NON_ASCII_KEYS, ...LONE_SURROGATE_KEYS];
  for (const key of special) {
    expect(
      count((e) => e.context.key === key && e.expected.reason === 'rollout'),
      JSON.stringify(key),
    ).toBeGreaterThanOrEqual(1);
  }
});
