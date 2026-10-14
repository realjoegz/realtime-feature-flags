// evaluate() against the reference evaluator in test/reference/, which shares no
// code with src/. The generators draw attribute names and values from small shared
// pools, so rules match often and overlap, and in three runs out of four the
// percentage sits at the user's bucket or next to it. The pools hold near misses
// (case, surrounding spaces, Unicode normalization), so an evaluator that compares
// leniently disagrees. Each branch must be taken in at least 5 percent of the runs,
// or the property says little about it.

import fc from 'fast-check';
import { expect, it } from 'vitest';
import { evaluate } from '../src/index.ts';
import {
  caseInsensitiveNames,
  caseInsensitiveValues,
  charCodeBuckets,
  evaluatorWith,
  lastMatchWins,
  lessOrEqual,
  missingAttributeAsEmpty,
  normalizedValues,
  trimmedValues,
  type Evaluate,
} from './controls/broken-evaluators.ts';
import { referenceEvaluate } from './reference/reference-evaluator.ts';
import * as arb from './support/arbitraries.ts';
import { edgeCases } from './support/edges.ts';
import { branchOf, sameEvaluation, type Branch } from './support/compare.ts';
import { label, runParams } from './support/fc-params.ts';

const DIFFERENTIAL = runParams(3000);
const BRANCH_FLOOR = 0.05;

// Every run also starts with the users at buckets 0 and 9999 next to their boundaries.
const WITH_EDGES = { ...DIFFERENTIAL, examples: edgeCases().map((edge): [typeof edge] => [edge]) };

function agreesWithReference(subject: Evaluate, counts?: Record<Branch, number>) {
  return fc.property(arb.flagAndContext, ({ flag, context }) => {
    const expected = referenceEvaluate(flag, context);
    if (counts) counts[branchOf(expected)] += 1;
    return sameEvaluation(subject(flag, context), expected);
  });
}

it(`evaluate() agrees with the reference evaluator on value, reason, rule index and bucket, each branch in at least 5 percent of runs ${label(DIFFERENTIAL)}`, () => {
  const counts: Record<Branch, number> = {
    disabled: 0,
    rule: 0,
    'rollout-in': 0,
    'rollout-out': 0,
  };
  fc.assert(agreesWithReference(evaluate, counts), WITH_EDGES);

  const floor = Math.ceil(DIFFERENTIAL.numRuns * BRANCH_FLOOR);
  for (const [branch, count] of Object.entries(counts)) {
    expect(count, `${branch} ran ${count} times, floor ${floor}`).toBeGreaterThanOrEqual(floor);
  }
});

/** The names of the controls the differential property does not falsify. */
function notFalsified(controls: Record<string, Evaluate>): string[] {
  return Object.entries(controls)
    .filter(
      ([, control]) =>
        !fc.check(agreesWithReference(control), { ...WITH_EDGES, endOnFailure: true }).failed,
    )
    .map(([name]) => name);
}

it(`control scaffold: the broken evaluators' scaffold with no part replaced agrees with the reference evaluator ${label(DIFFERENTIAL)}`, () => {
  fc.assert(agreesWithReference(evaluatorWith({})), WITH_EDGES);
});

it(`differential control: last match wins, a missing attribute read as the empty string, less-or-equal and UTF-16 code units are each falsified ${label(DIFFERENTIAL)}`, () => {
  expect(
    notFalsified({ lastMatchWins, missingAttributeAsEmpty, lessOrEqual, charCodeBuckets }),
  ).toEqual([]);
});

it(`differential control: case-insensitive, trimmed and NFC-normalized attribute values and case-insensitive attribute names are each falsified ${label(DIFFERENTIAL)}`, () => {
  expect(
    notFalsified({ caseInsensitiveValues, trimmedValues, normalizedValues, caseInsensitiveNames }),
  ).toEqual([]);
});
