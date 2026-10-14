// Compares two evaluation results on all four fields. A field that is absent
// counts as null, so `{ value, reason: 'rule', ruleIndex: 0 }` never equals a
// result that has a bucket.

interface EvaluationLike {
  readonly value: boolean;
  readonly reason: string;
  readonly ruleIndex?: number;
  readonly bucket?: number;
}

export function fieldsOf(result: unknown): [unknown, unknown, unknown, unknown] {
  const r = result as Partial<EvaluationLike>;
  return [r.value, r.reason, r.ruleIndex ?? null, r.bucket ?? null];
}

export function sameEvaluation(a: unknown, b: unknown): boolean {
  const left = fieldsOf(a);
  const right = fieldsOf(b);
  return left.every((field, index) => field === right[index]);
}

export type Branch = 'disabled' | 'rule' | 'rollout-in' | 'rollout-out';

export function branchOf(result: EvaluationLike): Branch {
  if (result.reason === 'rollout') return result.value ? 'rollout-in' : 'rollout-out';
  return result.reason === 'rule' ? 'rule' : 'disabled';
}
