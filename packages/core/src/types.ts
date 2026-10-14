/** Rule operators. `equals` compares with one value, `in` with any of a list. */
export type Operator = 'equals' | 'in';

/**
 * A targeting rule. It matches when the context has the attribute and its value
 * passes the operator. Rules are tried in order and the first match decides.
 */
export interface Rule {
  readonly attribute: string;
  readonly operator: Operator;
  /** `equals` takes exactly one value, `in` at least one. */
  readonly values: readonly string[];
  /** The value served to a context that matches this rule. */
  readonly serve: boolean;
}

/** A boolean flag with ordered rules and a percentage rollout in basis points. */
export interface Flag {
  /** Matches FLAG_KEY_PATTERN. */
  readonly key: string;
  readonly enabled: boolean;
  /** 16 lowercase hex characters, set when the flag is created and never changed. */
  readonly salt: string;
  readonly rules: readonly Rule[];
  /** 0 to 10000: 1 basis point is 0.01 percent of users. */
  readonly rolloutBasisPoints: number;
}

/** The user (or other subject) a flag is evaluated for. Attribute values are strings. */
export interface Context {
  readonly key: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export type Reason = 'disabled' | 'rule' | 'rollout';

/** The outcome of evaluate(): the value and the branch that produced it. */
export type Evaluation =
  | { readonly value: false; readonly reason: 'disabled' }
  | { readonly value: boolean; readonly reason: 'rule'; readonly ruleIndex: number }
  | { readonly value: boolean; readonly reason: 'rollout'; readonly bucket: number };
