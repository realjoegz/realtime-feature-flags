// Committed broken subjects. Each one is the evaluator from src/evaluate.ts with a
// single part replaced by a plausible bug. The rollout properties must pass on
// src/ and must be falsified on each of these; a property that a broken subject
// passes proves nothing.

import { randomBytes } from 'node:crypto';
import {
  BUCKET_COUNT,
  bucketInput,
  murmur3X86_32,
  murmur3X86_32Utf8,
  type Context,
  type Evaluation,
  type Flag,
  type Rule,
} from '../../src/index.ts';

export type Evaluate = (flag: Flag, context: Context) => Evaluation;

interface Parts {
  bucket?: (flag: Flag, userKey: string) => number;
  inRollout?: (bucket: number, basisPoints: number) => boolean;
  firstMatch?: FirstMatch;
}

function correctBucket(flag: Flag, userKey: string): number {
  return murmur3X86_32Utf8(bucketInput(flag.key, flag.salt, userKey), 0) % BUCKET_COUNT;
}

type FirstMatch = (rules: readonly Rule[], attributes: Readonly<Record<string, string>>) => number;

const same = (text: string): string => text;

/**
 * The first rule that matches after the rule's attribute name passes through
 * `nameOf` and the context's value through `valueOf`. Both are the identity in a
 * correct evaluator.
 */
function firstMatchReading(nameOf: (name: string) => string, valueOf: (value: string) => string) {
  const firstMatch: FirstMatch = (rules, attributes) =>
    rules.findIndex((rule) => {
      const name = nameOf(rule.attribute);
      if (!Object.hasOwn(attributes, name)) return false;
      const actual = valueOf(attributes[name] ?? '');
      return rule.operator === 'equals' ? actual === rule.values[0] : rule.values.includes(actual);
    });
  return firstMatch;
}

const correctFirstMatch = firstMatchReading(same, same);

/** The evaluator with the given parts replaced. With no part replaced it is correct. */
export function evaluatorWith(parts: Parts): Evaluate {
  const bucketOf = parts.bucket ?? correctBucket;
  const inRollout = parts.inRollout ?? ((bucket, basisPoints) => bucket < basisPoints);
  const firstMatch = parts.firstMatch ?? correctFirstMatch;
  return (flag, context) => {
    if (!flag.enabled) return { value: false, reason: 'disabled' };
    if (context.attributes !== undefined) {
      const ruleIndex = firstMatch(flag.rules, context.attributes);
      const rule = flag.rules[ruleIndex];
      if (rule !== undefined) return { value: rule.serve, reason: 'rule', ruleIndex };
    }
    const bucket = bucketOf(flag, context.key);
    return { value: inRollout(bucket, flag.rolloutBasisPoints), reason: 'rollout', bucket };
  };
}

/** P1: the bucket comes from Math.random instead of the hash. */
export const randomBucket = evaluatorWith({
  bucket: () => Math.floor(Math.random() * BUCKET_COUNT),
});

/** P2: the percentage is part of the hash input, so a change of percentage reshuffles users. */
export const percentageInHashInput = evaluatorWith({
  bucket: (flag, userKey) =>
    murmur3X86_32Utf8(`${bucketInput(flag.key, flag.salt, userKey)}.${flag.rolloutBasisPoints}`) %
    BUCKET_COUNT,
});

/** P3: `<=` in place of `<`, so a bucket equal to the percentage is let in. */
export const lessOrEqual = evaluatorWith({
  inRollout: (bucket, basisPoints) => bucket <= basisPoints,
});

/** P5: a hash that ignores its input. */
export const constantHash = evaluatorWith({
  bucket: () => murmur3X86_32Utf8('constant', 0) % BUCKET_COUNT,
});

/** Differential: the last matching rule wins instead of the first. */
export const lastMatchWins = evaluatorWith({
  firstMatch: (rules, attributes) => {
    for (let index = rules.length - 1; index >= 0; index--) {
      if (correctFirstMatch(rules.slice(index, index + 1), attributes) === 0) return index;
    }
    return -1;
  },
});

/** Differential: a missing attribute is read as the empty string. */
export const missingAttributeAsEmpty = evaluatorWith({
  firstMatch: (rules, attributes) =>
    rules.findIndex((rule) => {
      const actual = Object.hasOwn(attributes, rule.attribute)
        ? (attributes[rule.attribute] ?? '')
        : '';
      return rule.operator === 'equals' ? actual === rule.values[0] : rule.values.includes(actual);
    }),
});

/** Differential: attribute values are compared ignoring case. */
export const caseInsensitiveValues = evaluatorWith({
  firstMatch: firstMatchReading(same, (value) => value.toLowerCase()),
});

/** Differential: attribute values are trimmed before they are compared. */
export const trimmedValues = evaluatorWith({
  firstMatch: firstMatchReading(same, (value) => value.trim()),
});

/** Differential: attribute values are NFC-normalized before they are compared. */
export const normalizedValues = evaluatorWith({
  firstMatch: firstMatchReading(same, (value) => value.normalize('NFC')),
});

/** Differential: a rule's attribute name is looked up in lower case. */
export const caseInsensitiveNames = evaluatorWith({
  firstMatch: firstMatchReading((name) => name.toLowerCase(), same),
});

/**
 * P4: the salt is regenerated whenever the percentage goes down, so lowering and
 * raising again moves users. Stateful: one instance per check. With `resalt`
 * false the same bookkeeping runs and the salt never changes.
 */
export function createResaltOnLowering(resalt = true): Evaluate {
  const state = new Map<string, { basisPoints: number; salt: string }>();
  return evaluatorWith({
    bucket: (flag, userKey) => {
      const previous = state.get(flag.key);
      let salt = previous?.salt ?? flag.salt;
      if (resalt && previous !== undefined && flag.rolloutBasisPoints < previous.basisPoints) {
        salt = randomBytes(8).toString('hex');
      }
      state.set(flag.key, { basisPoints: flag.rolloutBasisPoints, salt });
      return correctBucket({ ...flag, salt }, userKey);
    },
  });
}

/** P6 and differential: hashes the low byte of each UTF-16 code unit instead of UTF-8 bytes. */
export function charCodeHash(text: string, seed: number): number {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return murmur3X86_32(bytes, seed);
}

export const charCodeBuckets = evaluatorWith({
  bucket: (flag, userKey) =>
    charCodeHash(bucketInput(flag.key, flag.salt, userKey), 0) % BUCKET_COUNT,
});
