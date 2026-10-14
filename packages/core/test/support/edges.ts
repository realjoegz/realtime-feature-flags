// The users whose buckets are 0 and 9999 for one fixed flag. Random user keys
// almost never land in either bucket, so properties take these as examples.

import type { Context, Flag } from '../../src/index.ts';
import { referenceBucket } from '../reference/reference-evaluator.ts';

/** A rules-free flag with the first `user-<n>` key whose bucket is 0, then the one at 9999. */
export function usersAtTheEnds(): [Flag, Context][] {
  const flag: Flag = {
    key: 'checkout-redesign',
    enabled: true,
    salt: '5f0c2a9e41b7d386',
    rules: [],
    rolloutBasisPoints: 0,
  };
  const found = new Map<number, string>();
  for (let n = 0; found.size < 2; n++) {
    const key = `user-${n}`;
    const bucket = referenceBucket(flag.key, flag.salt, key);
    if ((bucket === 0 || bucket === 9999) && !found.has(bucket)) found.set(bucket, key);
  }
  return [0, 9999].map((bucket) => [flag, { key: found.get(bucket) ?? '' }]);
}

/**
 * The users at buckets 0 and 9999, each at the two percentages around its
 * bucket: bucket 0 at 0 and 1 basis points, bucket 9999 at 9999 and 10000.
 */
export function edgeCases(): { flag: Flag; context: Context }[] {
  const percentages = [
    [0, 1],
    [9999, 10_000],
  ];
  return usersAtTheEnds().flatMap(([flag, context], index) =>
    (percentages[index] ?? []).map((rolloutBasisPoints) => ({
      flag: { ...flag, rolloutBasisPoints },
      context,
    })),
  );
}
