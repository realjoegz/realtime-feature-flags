// fast-check generators shared by the core tests.

import fc from 'fast-check';
import type { Context, Flag, Rule } from '../../src/index.ts';
import { referenceBucket } from '../reference/reference-evaluator.ts';
import {
  ATTRIBUTE_NAMES,
  ATTRIBUTE_VALUES,
  LONE_SURROGATE_KEYS,
  NON_ASCII_KEYS,
  nearMisses,
  sameAfterFolding,
} from './pools.ts';

export const flagKey = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const salt = fc.stringMatching(/^[0-9a-f]{16}$/);

/** Basis points with extra weight on both ends and their neighbours. */
export const basisPoints = fc.oneof(
  fc.constantFrom(0, 1, 9999, 10_000),
  fc.integer({ min: 0, max: 10_000 }),
);

/** User keys: empty, ASCII, Unicode graphemes, any code point, fixed non-ASCII and lone surrogates. */
export const userKey = fc.oneof(
  fc.constant(''),
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.constantFrom(...NON_ASCII_KEYS, ...LONE_SURROGATE_KEYS),
  fc.nat().map((n) => `user-${n}`),
);

const attributeName = fc.constantFrom(...ATTRIBUTE_NAMES);
const attributeValue = fc.oneof(
  { arbitrary: fc.constantFrom(...ATTRIBUTE_VALUES), weight: 4 },
  { arbitrary: fc.string({ unit: 'grapheme', maxLength: 6 }), weight: 1 },
);

export const rule: fc.Arbitrary<Rule> = fc.oneof(
  fc.record({
    attribute: attributeName,
    operator: fc.constant('equals' as const),
    values: fc.constantFrom(...ATTRIBUTE_VALUES).map((value) => [value]),
    serve: fc.boolean(),
  }),
  fc.record({
    attribute: attributeName,
    operator: fc.constant('in' as const),
    values: fc.uniqueArray(fc.constantFrom(...ATTRIBUTE_VALUES), { minLength: 1, maxLength: 4 }),
    serve: fc.boolean(),
  }),
);

export const rules = fc.array(rule, { maxLength: 5 });

export const attributes = fc.dictionary(attributeName, attributeValue, { maxKeys: 4 });

export const context: fc.Arbitrary<Context> = fc.oneof(
  userKey.map((key) => ({ key })),
  fc.record({ key: userKey, attributes }),
);

/** An enabled flag with any rules and percentage. */
export const enabledFlag: fc.Arbitrary<Flag> = fc.record({
  key: flagKey,
  enabled: fc.constant(true),
  salt,
  rules,
  rolloutBasisPoints: basisPoints,
});

/** Any valid flag; one in five is disabled. */
export const flag: fc.Arbitrary<Flag> = fc.record({
  key: flagKey,
  enabled: fc.oneof(
    { arbitrary: fc.constant(true), weight: 4 },
    { arbitrary: fc.constant(false), weight: 1 },
  ),
  salt,
  rules,
  rolloutBasisPoints: basisPoints,
});

/**
 * A context for a given flag. Half the time an attribute's value is taken from a
 * rule on the same attribute, so rules match often and several can match at once.
 * A quarter of the time it is a rule value, or a near miss of one, from a rule on
 * a name that differs only in case, surrounding spaces or normalization.
 */
export function contextFor(target: Flag): fc.Arbitrary<Context> {
  const valueFor = (name: string): fc.Arbitrary<string> => {
    const exact = target.rules.filter((r) => r.attribute === name).flatMap((r) => r.values);
    const near = [
      ...new Set(
        target.rules
          .filter((r) => sameAfterFolding(r.attribute, name))
          .flatMap((r) => r.values.flatMap((value) => [value, ...nearMisses(value)])),
      ),
    ];
    const choices: fc.WeightedArbitrary<string>[] = [{ arbitrary: attributeValue, weight: 1 }];
    if (exact.length > 0) choices.push({ arbitrary: fc.constantFrom(...exact), weight: 2 });
    if (near.length > 0) choices.push({ arbitrary: fc.constantFrom(...near), weight: 1 });
    return fc.oneof(...choices);
  };
  const biasedAttributes = fc
    .uniqueArray(attributeName, { maxLength: 4 })
    .chain((names) =>
      fc
        .tuple(...names.map(valueFor))
        .map((values) => Object.fromEntries(names.map((name, i) => [name, values[i] ?? '']))),
    );
  return fc.oneof(
    userKey.map((key) => ({ key })),
    fc.record({ key: userKey, attributes: biasedAttributes }),
  );
}

/**
 * A flag and a context for it. In three runs out of four the percentage is set to
 * the user's bucket - 1, bucket or bucket + 1, so the boundary between in and out
 * is hit on both sides.
 */
export const flagAndContext: fc.Arbitrary<{ flag: Flag; context: Context }> = flag
  .chain((generated) =>
    fc.tuple(fc.constant(generated), contextFor(generated), fc.integer({ min: 0, max: 3 })),
  )
  .map(([generated, ctx, choice]) => {
    if (choice === 0) return { flag: generated, context: ctx };
    const bucket = referenceBucket(generated.key, generated.salt, ctx.key);
    const adjacent = Math.min(10_000, Math.max(0, bucket + choice - 2));
    return { flag: { ...generated, rolloutBasisPoints: adjacent }, context: ctx };
  });

/** The entries of `extra` whose names none of the flag's rules read. */
export function unreferencedAttributes(
  target: Flag,
  extra: Record<string, string>,
): [string, string][] {
  const referenced = new Set(target.rules.map((r) => r.attribute));
  return Object.entries(extra).filter(([name]) => !referenced.has(name));
}
