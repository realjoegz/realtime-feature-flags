// P6: MurmurHash3_x86_32 against published vectors.
//
// Sources:
// - Ian Boyd, answer 31929528 to "MurmurHash3 test vectors", Stack Overflow,
//   https://stackoverflow.com/a/31929528. The byte and string vectors below are
//   copied from that answer, whose implementation passes SMHasher's verification
//   test. The string vectors are UTF-8 with no terminator; "ππππππππ" is eight
//   U+03C0, 16 bytes.
// - Austin Appleby, SMHasher, https://github.com/aappleby/smhasher: src/main.cpp
//   lists the verification value 0xB0F57EE3 for MurmurHash3_x86_32, computed by
//   VerificationTest in src/KeysetTest.cpp.

import fc from 'fast-check';
import { expect, it } from 'vitest';
import { bucketInput, bucketOf, murmur3X86_32, murmur3X86_32Utf8 } from '../src/index.ts';
import { charCodeHash } from './controls/broken-evaluators.ts';
import { encodeUtf8, referenceMurmur3 } from './reference/reference-evaluator.ts';
import * as arb from './support/arbitraries.ts';
import { label, runParams } from './support/fc-params.ts';
import { LONE_SURROGATE_KEYS, NON_ASCII_KEYS } from './support/pools.ts';

type HashBytes = (bytes: Uint8Array, seed: number) => number;
type HashString = (text: string, seed: number) => number;
type Vector<T> = readonly [input: T, seed: number, expected: number];

const BYTE_VECTORS: readonly Vector<string>[] = [
  ['', 0, 0],
  ['', 1, 0x514e28b7],
  ['', 0xffffffff, 0x81f16f39],
  ['ffffffff', 0, 0x76293b50],
  ['21436587', 0, 0xf55b516b],
  ['21436587', 0x5082edee, 0x2362f9de],
  ['214365', 0, 0x7e4a8634],
  ['2143', 0, 0xa0f7b07a],
  ['21', 0, 0x72661cf4],
  ['00000000', 0, 0x2362f9de],
  ['000000', 0, 0x85f0b427],
  ['0000', 0, 0x30f4c306],
  ['00', 0, 0x514e28b7],
];

const STRING_VECTORS: readonly Vector<string>[] = [
  ['', 0, 0],
  ['', 1, 0x514e28b7],
  ['', 0xffffffff, 0x81f16f39],
  ['\0\0\0\0', 0, 0x2362f9de],
  ['aaaa', 0x9747b28c, 0x5a97808a],
  ['aaa', 0x9747b28c, 0x283e0130],
  ['aa', 0x9747b28c, 0x5d211726],
  ['a', 0x9747b28c, 0x7fa09ea6],
  ['abcd', 0x9747b28c, 0xf0478627],
  ['abc', 0x9747b28c, 0xc84a62dd],
  ['ab', 0x9747b28c, 0x74875592],
  ['Hello, world!', 0x9747b28c, 0x24884cba],
  ['ππππππππ', 0x9747b28c, 0xd58063c1],
  ['a'.repeat(256), 0x9747b28c, 0x37405bdc],
  ['abc', 0, 0xb3dd93fa],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 0, 0xee925b90],
  ['The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2fa826cd],
];

const SMHASHER_VERIFICATION = 0xb0f57ee3;

function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** SMHasher's VerificationTest: hash keys {}, {0}, {0,1} ... with seeds 256 down to 1, then hash the hashes. */
function smhasherVerification(hash: HashBytes): number {
  const key = new Uint8Array(256);
  const hashes = new Uint8Array(4 * 256);
  const view = new DataView(hashes.buffer);
  for (let i = 0; i < 256; i++) {
    key[i] = i;
    view.setUint32(i * 4, hash(key.subarray(0, i), 256 - i), true);
  }
  return hash(hashes, 0);
}

function byteVectorsPass(hash: HashBytes): boolean {
  return BYTE_VECTORS.every(([hex, seed, expected]) => hash(bytesFromHex(hex), seed) === expected);
}

/** P6 as a property over the published string vectors; every vector runs as an example. */
function stringVectorProperty(hash: HashString) {
  return fc.property(
    fc.constantFrom(...STRING_VECTORS),
    ([text, seed, expected]) => hash(text, seed) === expected,
  );
}

const vectorRuns = { ...runParams(STRING_VECTORS.length), numRuns: STRING_VECTORS.length };
const vectorExamples = STRING_VECTORS.map((vector): [Vector<string>] => [vector]);

it('P6 MurmurHash3_x86_32 gives the 13 published byte vectors', () => {
  for (const [hex, seed, expected] of BYTE_VECTORS) {
    expect(murmur3X86_32(bytesFromHex(hex), seed), `${hex} seed ${seed}`).toBe(expected);
  }
});

it('P6 MurmurHash3_x86_32 passes the SMHasher verification test with 0xB0F57EE3', () => {
  expect(smhasherVerification(murmur3X86_32)).toBe(SMHASHER_VERIFICATION);
});

it('P6 a string is hashed as its UTF-8 bytes: the 17 published string vectors, ππππππππ included', () => {
  for (const [text, seed, expected] of STRING_VECTORS) {
    expect(murmur3X86_32Utf8(text, seed), text).toBe(expected);
  }
  const details = fc.check(stringVectorProperty(murmur3X86_32Utf8), {
    ...vectorRuns,
    examples: vectorExamples,
  });
  expect(details.failed).toBe(false);
  expect(details.numRuns).toBeGreaterThanOrEqual(STRING_VECTORS.length);
});

it('P6 control: hashing UTF-16 code units in place of UTF-8 bytes is falsified on ππππππππ', () => {
  const details = fc.check(stringVectorProperty(charCodeHash), {
    ...vectorRuns,
    examples: vectorExamples,
    endOnFailure: true,
  });
  expect(details.failed).toBe(true);
  expect(details.counterexample?.[0][0]).toBe('ππππππππ');
});

const referenceBytes: HashBytes = (bytes, seed) => referenceMurmur3([...bytes], seed);

it('P6 the reference MurmurHash3 gives the same published vectors and verification value', () => {
  expect(byteVectorsPass(referenceBytes)).toBe(true);
  for (const [text, seed, expected] of STRING_VECTORS) {
    expect(referenceMurmur3(encodeUtf8(text), seed), text).toBe(expected);
  }
  expect(smhasherVerification(referenceBytes)).toBe(SMHASHER_VERIFICATION);
});

const ENCODER = runParams(2000);
const anyCodeUnits = fc.string({
  unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
  maxLength: 16,
});

it(`P6 the reference UTF-8 encoder agrees with TextEncoder, lone surrogates included ${label(ENCODER)}`, () => {
  const encoder = new TextEncoder();
  fc.assert(
    fc.property(fc.oneof(anyCodeUnits, fc.string({ unit: 'binary' })), (text) => {
      expect(encodeUtf8(text)).toEqual([...encoder.encode(text)]);
    }),
    {
      ...ENCODER,
      examples: [...NON_ASCII_KEYS, ...LONE_SURROGATE_KEYS].map((text): [string] => [text]),
    },
  );
});

// P6 for buckets: the bucket evaluate() uses is the hash above, over the UTF-8
// bytes TextEncoder gives for flag key, salt and user key joined by ".", seed 0,
// mod 10000.

type Bucket = (flagKey: string, salt: string, userKey: string) => number;

const BUCKETS = runParams(2000);
const textEncoder = new TextEncoder();

function bucketProperty(bucket: Bucket) {
  return fc.property(arb.flagKey, arb.salt, arb.userKey, (flagKey, salt, userKey) => {
    const bytes = textEncoder.encode(`${flagKey}.${salt}.${userKey}`);
    return bucket(flagKey, salt, userKey) === murmur3X86_32(bytes, 0) % 10_000;
  });
}

const BUCKET_FLAG = ['checkout-redesign', '5f0c2a9e41b7d386'] as const;
const bucketExamples = ['user-1', ...NON_ASCII_KEYS, ...LONE_SURROGATE_KEYS].map(
  (userKey): [string, string, string] => [BUCKET_FLAG[0], BUCKET_FLAG[1], userKey],
);

/** Buckets for flag checkout-redesign with salt 5f0c2a9e41b7d386, from the reference evaluator. */
const FIXED_BUCKETS: readonly [userKey: string, bucket: number][] = [
  ['user-1', 1332],
  ['ππππππππ', 507],
  ['日本語', 2923],
  ['user-🚀', 535],
  ['\uD800', 5342],
];

it(`P6 a user's bucket is MurmurHash3_x86_32 of the UTF-8 bytes of flag key, salt and user key joined by dots, seed 0, mod 10000 ${label(BUCKETS)}`, () => {
  fc.assert(bucketProperty(bucketOf), { ...BUCKETS, examples: bucketExamples });
  for (const [userKey, bucket] of FIXED_BUCKETS) {
    expect(bucketOf(...BUCKET_FLAG, userKey), JSON.stringify(userKey)).toBe(bucket);
  }
});

const charCodeBucket: Bucket = (flagKey, salt, userKey) =>
  charCodeHash(bucketInput(flagKey, salt, userKey), 0) % 10_000;

it(`P6 control: buckets from UTF-16 code units in place of UTF-8 bytes are falsified ${label(BUCKETS)}`, () => {
  const details = fc.check(bucketProperty(charCodeBucket), {
    ...BUCKETS,
    examples: bucketExamples,
    endOnFailure: true,
  });
  expect(details.failed).toBe(true);
});
