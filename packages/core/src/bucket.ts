import { murmur3X86_32Utf8 } from './murmur3.ts';

/** Users fall into one of 10000 buckets, one per basis point. */
export const BUCKET_COUNT = 10_000;

/**
 * The hash input for a user's bucket. Flag keys and salts cannot contain ".",
 * so the three parts can always be told apart.
 */
export function bucketInput(flagKey: string, salt: string, userKey: string): string {
  return `${flagKey}.${salt}.${userKey}`;
}

/** The user's bucket for a flag: 0 to 9999, the same in every process and on every machine. */
export function bucketOf(flagKey: string, salt: string, userKey: string): number {
  return murmur3X86_32Utf8(bucketInput(flagKey, salt, userKey), 0) % BUCKET_COUNT;
}
