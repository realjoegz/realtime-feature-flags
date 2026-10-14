import { bucketOf } from './bucket.ts';
import type { Context, Evaluation, Flag, Rule } from './types.ts';

function ruleMatches(rule: Rule, actual: string): boolean {
  return rule.operator === 'equals' ? actual === rule.values[0] : rule.values.includes(actual);
}

/**
 * Evaluates a flag for a context.
 *
 * A disabled flag gives false. Otherwise the first rule whose attribute is present
 * in the context and matches gives its `serve` value. Otherwise the user's bucket
 * decides: the value is true when the bucket is below the rollout in basis points.
 */
export function evaluate(flag: Flag, context: Context): Evaluation {
  if (!flag.enabled) {
    return { value: false, reason: 'disabled' };
  }

  const attributes = context.attributes;
  if (attributes !== undefined) {
    for (const [index, rule] of flag.rules.entries()) {
      if (!Object.hasOwn(attributes, rule.attribute)) continue;
      const actual = attributes[rule.attribute];
      if (actual !== undefined && ruleMatches(rule, actual)) {
        return { value: rule.serve, reason: 'rule', ruleIndex: index };
      }
    }
  }

  const bucket = bucketOf(flag.key, flag.salt, context.key);
  return { value: bucket < flag.rolloutBasisPoints, reason: 'rollout', bucket };
}
