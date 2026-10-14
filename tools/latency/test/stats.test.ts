import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { summarize } from '../src/stats.ts';

const SEED = 20261014;
const RUNS = 500;

// Times in ms with three decimals, as the results files hold them; the narrow range
// gives many equal samples.
const sample = fc
  .oneof(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 10_000_000 }))
  .map((microseconds) => microseconds / 1000);

/**
 * The statistics by their definitions, from how many samples lie at or below each
 * one, without sorting: the k-th smallest is the smallest sample with at least k
 * samples at or below it.
 */
function byDefinition(values: readonly number[]) {
  const n = values.length;
  const atOrBelow = values.map((x) => values.filter((value) => value <= x).length);
  const smallestWith = (enough: (count: number) => boolean): number =>
    Math.min(...values.filter((_, index) => enough(atOrBelow[index]!)));
  const kth = (k: number) => smallestWith((count) => count >= k);
  return {
    count: n,
    min: kth(1),
    median: n % 2 === 1 ? kth((n + 1) / 2) : (kth(n / 2) + kth(n / 2 + 1)) / 2,
    p95: smallestWith((count) => 100 * count >= 95 * n),
    max: kth(n),
  };
}

/** n down to 1. */
const upTo = (n: number) => Array.from({ length: n }, (_, index) => n - index);

describe('summarize', () => {
  it(`gives the smallest and largest sample, the middle sample or the mean of the two middle ones, and as p95 the smallest sample with at least 95 percent of the samples at or below it, without changing its input (seed ${SEED}, ${RUNS} runs)`, () => {
    fc.assert(
      fc.property(fc.array(sample, { minLength: 1, maxLength: 200 }), (values) => {
        const before = [...values];
        expect(summarize(values)).toEqual(byDefinition(values));
        expect(values).toEqual(before);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('for 1 to 20 ms gives median 10.5 and p95 19, for 1 to 100 ms median 50.5 and p95 95, and for one sample that sample throughout; it refuses no samples and samples that are not finite', () => {
    expect(summarize(upTo(20))).toEqual({ count: 20, min: 1, median: 10.5, p95: 19, max: 20 });
    expect(summarize(upTo(100))).toEqual({ count: 100, min: 1, median: 50.5, p95: 95, max: 100 });
    expect(summarize([7.25])).toEqual({ count: 1, min: 7.25, median: 7.25, p95: 7.25, max: 7.25 });
    expect(() => summarize([])).toThrow('no samples');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => summarize([1, bad])).toThrow('finite');
    }
  });
});
