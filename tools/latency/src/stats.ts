// The summary of one run's measured changes. Each value is a sample, not an
// estimate: min and max are the smallest and largest, the median is the middle
// sample (the mean of the two middle ones for an even count), and p95 is the
// nearest-rank 95th percentile: the smallest sample that at least 95 percent of
// the samples are at or below. No p99 is reported: below about 1,000 samples it is
// one of the last few values.

export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

/** The 1-based rank of the nearest-rank percentile, in integers so that 0.95 * n never rounds. */
export function nearestRank(percent: number, count: number): number {
  return Math.max(1, Math.ceil((percent * count) / 100));
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new RangeError('no samples to summarize');
  if (!values.every((value) => Number.isFinite(value))) {
    throw new RangeError('every sample must be a finite number');
  }
  const sorted = values.toSorted((a, b) => a - b);
  const count = sorted.length;
  const at = (rank: number): number => sorted[rank - 1] as number;
  const middle = count % 2 === 1 ? at((count + 1) / 2) : (at(count / 2) + at(count / 2 + 1)) / 2;
  return { count, min: at(1), median: middle, p95: at(nearestRank(95, count)), max: at(count) };
}
