import type { Context, Flag, Operator, Rule } from './types.ts';

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SALT_PATTERN = /^[0-9a-f]{16}$/;
export const MAX_BASIS_POINTS = 10_000;

/**
 * Size limits. Strings are counted in UTF-16 code units. A flag's JSON, in the
 * property order validateFlag returns, is at most 65,536 bytes of UTF-8.
 */
export const LIMITS = {
  rules: 100,
  valuesPerRule: 1000,
  attributes: 100,
  stringLength: 1024,
  flagJsonBytes: 65_536,
} as const;

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const FLAG_PROPERTIES = new Set(['key', 'enabled', 'salt', 'rules', 'rolloutBasisPoints']);
const RULE_PROPERTIES = new Set(['attribute', 'operator', 'values', 'serve']);
const CONTEXT_PROPERTIES = new Set(['key', 'attributes']);
const OPERATORS: ReadonlySet<string> = new Set<Operator>(['equals', 'in']);

const encoder = new TextEncoder();

function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function unknownProperties(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const name of Object.keys(input)) {
    if (!allowed.has(name)) errors.push(`${path}${JSON.stringify(name)}: unknown property`);
  }
}

function boundedString(value: unknown, minLength: number): value is string {
  return (
    typeof value === 'string' && value.length >= minLength && value.length <= LIMITS.stringLength
  );
}

/**
 * A string that PostgreSQL can hold in a jsonb column: no U+0000 and no unpaired
 * UTF-16 surrogate. Rules are stored; contexts are not, so context strings may
 * hold either.
 */
function storableString(value: unknown, minLength: number): value is string {
  return boundedString(value, minLength) && value.isWellFormed() && !value.includes('\u0000');
}

function validateRule(input: unknown, path: string, errors: string[]): Rule | undefined {
  if (!isRecord(input)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  const before = errors.length;
  unknownProperties(input, RULE_PROPERTIES, `${path}.`, errors);
  const { attribute, operator, values, serve } = input;

  if (!storableString(attribute, 1)) {
    errors.push(
      `${path}.attribute: must be a string of 1 to ${LIMITS.stringLength} characters, with no U+0000 and no unpaired surrogate`,
    );
  }
  if (typeof operator !== 'string' || !OPERATORS.has(operator)) {
    errors.push(`${path}.operator: must be "equals" or "in"`);
  }
  if (!Array.isArray(values)) {
    errors.push(`${path}.values: must be an array of strings`);
  } else {
    if (operator === 'equals' && values.length !== 1) {
      errors.push(`${path}.values: "equals" takes exactly one value`);
    }
    if (operator === 'in' && (values.length < 1 || values.length > LIMITS.valuesPerRule)) {
      errors.push(`${path}.values: "in" takes 1 to ${LIMITS.valuesPerRule} values`);
    }
    values.forEach((value: unknown, index) => {
      if (!storableString(value, 0)) {
        errors.push(
          `${path}.values[${index}]: must be a string of at most ${LIMITS.stringLength} characters, with no U+0000 and no unpaired surrogate`,
        );
      }
    });
  }
  if (typeof serve !== 'boolean') {
    errors.push(`${path}.serve: must be a boolean`);
  }

  if (errors.length > before) return undefined;
  return {
    attribute: attribute as string,
    operator: operator as Operator,
    values: [...(values as string[])],
    serve: serve as boolean,
  };
}

/** Checks that an unknown value is a well-formed Flag and returns a copy of it. */
export function validateFlag(input: unknown): Validation<Flag> {
  if (!isRecord(input)) return { ok: false, errors: ['flag: must be an object'] };
  const errors: string[] = [];
  unknownProperties(input, FLAG_PROPERTIES, '', errors);
  const { key, enabled, salt, rules, rolloutBasisPoints } = input;

  if (typeof key !== 'string' || !FLAG_KEY_PATTERN.test(key)) {
    errors.push(`key: must match ${FLAG_KEY_PATTERN.source}`);
  }
  if (typeof enabled !== 'boolean') {
    errors.push('enabled: must be a boolean');
  }
  if (typeof salt !== 'string' || !SALT_PATTERN.test(salt)) {
    errors.push(`salt: must match ${SALT_PATTERN.source}`);
  }
  const validRules: Rule[] = [];
  if (!Array.isArray(rules)) {
    errors.push('rules: must be an array');
  } else if (rules.length > LIMITS.rules) {
    errors.push(`rules: at most ${LIMITS.rules} rules`);
  } else {
    rules.forEach((rule: unknown, index) => {
      const valid = validateRule(rule, `rules[${index}]`, errors);
      if (valid !== undefined) validRules.push(valid);
    });
  }
  if (
    typeof rolloutBasisPoints !== 'number' ||
    !Number.isInteger(rolloutBasisPoints) ||
    rolloutBasisPoints < 0 ||
    rolloutBasisPoints > MAX_BASIS_POINTS
  ) {
    errors.push(`rolloutBasisPoints: must be an integer from 0 to ${MAX_BASIS_POINTS}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  const flag: Flag = {
    key: key as string,
    enabled: enabled as boolean,
    salt: salt as string,
    rules: validRules,
    rolloutBasisPoints: rolloutBasisPoints as number,
  };
  const bytes = encoder.encode(JSON.stringify(flag)).length;
  if (bytes > LIMITS.flagJsonBytes) {
    return {
      ok: false,
      errors: [`flag: its JSON is ${bytes} bytes, more than ${LIMITS.flagJsonBytes}`],
    };
  }
  return { ok: true, value: flag };
}

/** Checks that an unknown value is a well-formed Context and returns a copy of it. */
export function validateContext(input: unknown): Validation<Context> {
  if (!isRecord(input)) return { ok: false, errors: ['context: must be an object'] };
  const errors: string[] = [];
  unknownProperties(input, CONTEXT_PROPERTIES, '', errors);
  const { key, attributes } = input;

  if (!boundedString(key, 0)) {
    errors.push(`key: must be a string of at most ${LIMITS.stringLength} characters`);
  }
  let entries: [string, string][] | undefined;
  if (attributes !== undefined) {
    if (!isRecord(attributes)) {
      errors.push('attributes: must be an object of string values');
    } else {
      const all = Object.entries(attributes);
      if (all.length > LIMITS.attributes) {
        errors.push(`attributes: at most ${LIMITS.attributes} attributes`);
      }
      entries = [];
      for (const [name, value] of all) {
        if (!boundedString(name, 1)) {
          errors.push(
            `attributes: names must be strings of 1 to ${LIMITS.stringLength} characters`,
          );
        } else if (!boundedString(value, 0)) {
          errors.push(
            `attributes${JSON.stringify([name])}: must be a string of at most ${LIMITS.stringLength} characters`,
          );
        } else {
          entries.push([name, value]);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const copy: Context =
    entries === undefined
      ? { key: key as string }
      : { key: key as string, attributes: Object.fromEntries(entries) };
  return { ok: true, value: copy };
}
