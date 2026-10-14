// A second implementation of the evaluation rules, written from the specification
// for differential testing. It shares no code and no types with src/: UTF-8 is
// encoded from code points here, MurmurHash3 runs on BigInt instead of Math.imul,
// and rules are searched with findIndex instead of a loop.
//
// Specification: a disabled flag gives false with reason "disabled". Otherwise the
// first rule whose attribute is an own property of the context's attributes and
// whose operator matches gives its serve value with reason "rule" and its index.
// Otherwise bucket = MurmurHash3_x86_32(UTF-8(key + "." + salt + "." + userKey),
// seed 0) mod 10000, and the value is bucket < rolloutBasisPoints with reason
// "rollout" and the bucket.

export interface ReferenceRule {
  readonly attribute: string;
  readonly operator: 'equals' | 'in';
  readonly values: readonly string[];
  readonly serve: boolean;
}

export interface ReferenceFlag {
  readonly key: string;
  readonly enabled: boolean;
  readonly salt: string;
  readonly rules: readonly ReferenceRule[];
  readonly rolloutBasisPoints: number;
}

export interface ReferenceContext {
  readonly key: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export type ReferenceEvaluation =
  | { value: false; reason: 'disabled' }
  | { value: boolean; reason: 'rule'; ruleIndex: number }
  | { value: boolean; reason: 'rollout'; bucket: number };

const REPLACEMENT_CHARACTER = 0xfffd;

/** UTF-8 as the WHATWG Encoding Standard defines it: an unpaired surrogate becomes U+FFFD. */
export function encodeUtf8(text: string): number[] {
  const bytes: number[] = [];
  let position = 0;
  while (position < text.length) {
    const unit = text.charCodeAt(position);
    position += 1;
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = position < text.length ? text.charCodeAt(position) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + (unit - 0xd800) * 0x400 + (next - 0xdc00);
        position += 1;
      } else {
        codePoint = REPLACEMENT_CHARACTER;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      codePoint = REPLACEMENT_CHARACTER;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 + Math.floor(codePoint / 0x40), 0x80 + (codePoint % 0x40));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 + Math.floor(codePoint / 0x1000),
        0x80 + (Math.floor(codePoint / 0x40) % 0x40),
        0x80 + (codePoint % 0x40),
      );
    } else {
      bytes.push(
        0xf0 + Math.floor(codePoint / 0x40000),
        0x80 + (Math.floor(codePoint / 0x1000) % 0x40),
        0x80 + (Math.floor(codePoint / 0x40) % 0x40),
        0x80 + (codePoint % 0x40),
      );
    }
  }
  return bytes;
}

const MASK_32 = 0xffffffffn;

function multiply32(a: bigint, b: bigint): bigint {
  return (a * b) & MASK_32;
}

function rotateLeft32(x: bigint, by: bigint): bigint {
  return ((x << by) | (x >> (32n - by))) & MASK_32;
}

function littleEndianWord(bytes: readonly number[]): bigint {
  let word = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    word = (word << 8n) | BigInt(bytes[index] ?? 0);
  }
  return word;
}

function scramble(k: bigint): bigint {
  return multiply32(rotateLeft32(multiply32(k, 0xcc9e2d51n), 15n), 0x1b873593n);
}

/** MurmurHash3_x86_32 on BigInt, following SMHasher's MurmurHash3.cpp step by step. */
export function referenceMurmur3(bytes: readonly number[], seed: number): number {
  let h = BigInt(seed) & MASK_32;
  const fullBlocks = Math.floor(bytes.length / 4);
  for (let block = 0; block < fullBlocks; block++) {
    h ^= scramble(littleEndianWord(bytes.slice(block * 4, block * 4 + 4)));
    h = rotateLeft32(h, 13n);
    h = (multiply32(h, 5n) + 0xe6546b64n) & MASK_32;
  }
  const rest = bytes.slice(fullBlocks * 4);
  if (rest.length > 0) {
    h ^= scramble(littleEndianWord(rest));
  }
  h ^= BigInt(bytes.length) & MASK_32;
  h ^= h >> 16n;
  h = multiply32(h, 0x85ebca6bn);
  h ^= h >> 13n;
  h = multiply32(h, 0xc2b2ae35n);
  h ^= h >> 16n;
  return Number(h);
}

export function referenceBucket(flagKey: string, salt: string, userKey: string): number {
  const hash = referenceMurmur3(encodeUtf8([flagKey, salt, userKey].join('.')), 0);
  return Number(BigInt(hash) % 10000n);
}

function ruleMatches(rule: ReferenceRule, attributes: Readonly<Record<string, string>>): boolean {
  if (!Object.prototype.hasOwnProperty.call(attributes, rule.attribute)) return false;
  const actual = attributes[rule.attribute];
  switch (rule.operator) {
    case 'equals':
      return rule.values.length === 1 && rule.values[0] === actual;
    case 'in':
      return rule.values.some((candidate) => candidate === actual);
  }
}

export function referenceEvaluate(
  flag: ReferenceFlag,
  context: ReferenceContext,
): ReferenceEvaluation {
  if (flag.enabled !== true) return { value: false, reason: 'disabled' };

  const attributes = context.attributes ?? {};
  const ruleIndex = flag.rules.findIndex((rule) => ruleMatches(rule, attributes));
  const matched = flag.rules[ruleIndex];
  if (matched !== undefined) {
    return { value: matched.serve, reason: 'rule', ruleIndex };
  }

  const bucket = referenceBucket(flag.key, flag.salt, context.key);
  return { value: bucket < flag.rolloutBasisPoints, reason: 'rollout', bucket };
}
