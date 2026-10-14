import { describe, expect, it } from 'vitest';
import { LIMITS, validateContext, validateFlag } from '../src/index.ts';

const valid = {
  key: 'new-checkout',
  enabled: true,
  salt: '0123456789abcdef',
  rules: [
    { attribute: 'country', operator: 'in', values: ['us', 'gb'], serve: true },
    { attribute: 'plan', operator: 'equals', values: ['free'], serve: false },
  ],
  rolloutBasisPoints: 2500,
};

function errorsOf(result: ReturnType<typeof validateFlag> | ReturnType<typeof validateContext>) {
  return result.ok ? [] : result.errors;
}

/** A string of `length` characters. */
function chars(length: number): string {
  return 'a'.repeat(length);
}

function withRule(rule: object) {
  return { ...valid, rules: [rule] };
}

function inRule(attribute: string, values: string[]) {
  return { attribute, operator: 'in', values, serve: true };
}

function equalsRule(attribute: string, value: string) {
  return { attribute, operator: 'equals', values: [value], serve: true };
}

/** `count` values or attribute names: v0, v1, ... */
function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `v${index}`);
}

function attributesOf(count: number): Record<string, string> {
  return Object.fromEntries(numbered(count).map((name) => [name, 'v']));
}

describe('validateFlag', () => {
  it('accepts a valid flag and returns a copy', () => {
    const result = validateFlag(valid);
    expect(result).toEqual({ ok: true, value: valid });
    if (!result.ok) return;
    expect(result.value).not.toBe(valid);
    expect(result.value.rules[0]).not.toBe(valid.rules[0]);
  });

  it.each([
    ['key with an upper-case letter', { key: 'New' }, 'key: must match'],
    ['key starting with "-"', { key: '-a' }, 'key: must match'],
    ['key with a "."', { key: 'a.b' }, 'key: must match'],
    ['key of 65 characters', { key: 'a'.repeat(65) }, 'key: must match'],
    ['salt of 15 characters', { salt: '0123456789abcde' }, 'salt: must match'],
    ['salt with upper-case hex', { salt: '0123456789ABCDEF' }, 'salt: must match'],
    ['enabled as a string', { enabled: 'true' }, 'enabled: must be a boolean'],
    ['percentage above 10000', { rolloutBasisPoints: 10_001 }, 'rolloutBasisPoints'],
    ['negative percentage', { rolloutBasisPoints: -1 }, 'rolloutBasisPoints'],
    ['fractional percentage', { rolloutBasisPoints: 12.5 }, 'rolloutBasisPoints'],
    ['percentage as a string', { rolloutBasisPoints: '100' }, 'rolloutBasisPoints'],
    ['rules not an array', { rules: {} }, 'rules: must be an array'],
    ['an unknown property', { rollout: 5 }, '"rollout": unknown property'],
  ])('rejects a %s', (_name, change, message) => {
    const errors = errorsOf(validateFlag({ ...valid, ...change }));
    expect(errors.join('\n')).toContain(message);
  });

  it.each([
    ['"equals" with two values', { operator: 'equals', values: ['a', 'b'] }, 'exactly one value'],
    ['"in" with no values', { operator: 'in', values: [] }, '"in" takes 1 to'],
    ['an unknown operator', { operator: 'contains' }, 'operator: must be'],
    ['an empty attribute name', { attribute: '' }, 'attribute: must be'],
    ['a number among the values', { operator: 'in', values: ['a', 1] }, 'values[1]'],
    ['serve as a string', { serve: 'yes' }, 'serve: must be a boolean'],
    ['an unknown property', { weight: 1 }, '"weight": unknown property'],
  ])('rejects a rule with %s', (_name, change, message) => {
    const rules = [valid.rules[0], { ...valid.rules[1], ...change }];
    const errors = errorsOf(validateFlag({ ...valid, rules }));
    expect(errors.join('\n')).toContain(`rules[1]`);
    expect(errors.join('\n')).toContain(message);
  });

  it(`rejects more than ${LIMITS.rules} rules`, () => {
    const rules = Array.from({ length: LIMITS.rules + 1 }, () => valid.rules[1]);
    expect(errorsOf(validateFlag({ ...valid, rules }))).toEqual([
      `rules: at most ${LIMITS.rules} rules`,
    ]);
  });

  it('rejects values that are not plain objects', () => {
    for (const input of [null, 'flag', [], new Date()]) {
      expect(validateFlag(input)).toEqual({ ok: false, errors: ['flag: must be an object'] });
    }
  });
});

/** A valid flag whose JSON is exactly `target` bytes, padded with an "in" rule. */
function flagWithJsonBytes(target: number) {
  const rule = { attribute: 'pad', operator: 'in', values: [] as string[], serve: true };
  const flag = { ...valid, rules: [rule] };
  const size = () => new TextEncoder().encode(JSON.stringify(flag)).length;
  // Each further value adds its length plus 3 bytes: two quotes and a comma.
  const full = chars(LIMITS.stringLength);
  while (size() + full.length + 3 <= target) rule.values.push(full);
  const rest = target - size();
  if (rest >= 3) rule.values.push(chars(rest - 3));
  else rule.attribute += chars(rest);
  expect(size()).toBe(target);
  return flag;
}

describe('validateFlag limits', () => {
  it(`accepts ${LIMITS.valuesPerRule} values in an "in" rule and rejects ${LIMITS.valuesPerRule + 1}`, () => {
    const atLimit = inRule('country', numbered(LIMITS.valuesPerRule));
    const overLimit = inRule('country', numbered(LIMITS.valuesPerRule + 1));
    expect(validateFlag(withRule(atLimit)).ok).toBe(true);
    expect(errorsOf(validateFlag(withRule(overLimit)))).toEqual([
      `rules[0].values: "in" takes 1 to ${LIMITS.valuesPerRule} values`,
    ]);
  });

  it(`accepts rule attributes and values of ${LIMITS.stringLength} characters and rejects ${LIMITS.stringLength + 1}`, () => {
    const limit = LIMITS.stringLength;
    expect(validateFlag(withRule(equalsRule(chars(limit), chars(limit)))).ok).toBe(true);
    expect(
      errorsOf(validateFlag(withRule(equalsRule(chars(limit + 1), 'a')))).join('\n'),
    ).toContain('rules[0].attribute: must be a string of 1 to 1024 characters');
    expect(
      errorsOf(validateFlag(withRule(equalsRule('a', chars(limit + 1))))).join('\n'),
    ).toContain('rules[0].values[0]: must be a string of at most 1024 characters');
  });

  it('rejects U+0000 and unpaired surrogates in rule attributes and values, which jsonb cannot hold', () => {
    expect(validateFlag(withRule(inRule('région-🚀', ['日本', 'user-🚀', '']))).ok).toBe(true);
    for (const attribute of ['country\u0000', '\uD800', 'plan\uDFFF']) {
      expect(errorsOf(validateFlag(withRule(inRule(attribute, ['us'])))).join('\n')).toContain(
        'rules[0].attribute: must be a string',
      );
    }
    for (const value of ['\u0000', 'us\u0000', '\uD83D', 'x\uDE80y']) {
      expect(
        errorsOf(validateFlag(withRule(inRule('country', ['us', value])))).join('\n'),
      ).toContain('rules[0].values[1]: must be a string');
    }
  });

  it(`accepts a flag whose JSON is ${LIMITS.flagJsonBytes} bytes and rejects one of ${LIMITS.flagJsonBytes + 1}`, () => {
    expect(validateFlag(flagWithJsonBytes(LIMITS.flagJsonBytes)).ok).toBe(true);
    expect(errorsOf(validateFlag(flagWithJsonBytes(LIMITS.flagJsonBytes + 1)))).toEqual([
      `flag: its JSON is ${LIMITS.flagJsonBytes + 1} bytes, more than ${LIMITS.flagJsonBytes}`,
    ]);
    const multiByte = { ...valid, rules: [{ ...valid.rules[0], values: ['日'.repeat(1000)] }] };
    const copies = Array.from({ length: 22 }, () => multiByte.rules[0]);
    expect(errorsOf(validateFlag({ ...valid, rules: copies }))).toEqual([
      expect.stringMatching(/^flag: its JSON is \d+ bytes, more than 65536$/),
    ]);
  });
});

describe('validateContext', () => {
  it('accepts a context with an empty key and no attributes', () => {
    expect(validateContext({ key: '' })).toEqual({ ok: true, value: { key: '' } });
  });

  it('keeps an attribute named __proto__ as an own property', () => {
    const input = JSON.parse('{"key":"u","attributes":{"__proto__":"us"}}') as unknown;
    const result = validateContext(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value.attributes ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.value.attributes)).toBe(Object.prototype);
  });

  it(`accepts ${LIMITS.attributes} attributes and rejects ${LIMITS.attributes + 1}`, () => {
    expect(validateContext({ key: 'u', attributes: attributesOf(LIMITS.attributes) }).ok).toBe(
      true,
    );
    expect(
      errorsOf(validateContext({ key: 'u', attributes: attributesOf(LIMITS.attributes + 1) })),
    ).toEqual([`attributes: at most ${LIMITS.attributes} attributes`]);
  });

  it(`accepts context strings of ${LIMITS.stringLength} characters and rejects ${LIMITS.stringLength + 1}`, () => {
    const limit = LIMITS.stringLength;
    const atLimit = { key: chars(limit), attributes: { [chars(limit)]: chars(limit) } };
    expect(validateContext(atLimit).ok).toBe(true);
    expect(errorsOf(validateContext({ key: chars(limit + 1) })).join('\n')).toContain(
      'key: must be',
    );
    expect(
      errorsOf(validateContext({ key: 'u', attributes: { [chars(limit + 1)]: 'v' } })).join('\n'),
    ).toContain('attributes: names must be strings of 1 to 1024 characters');
    expect(
      errorsOf(validateContext({ key: 'u', attributes: { plan: chars(limit + 1) } })).join('\n'),
    ).toContain('attributes["plan"]: must be a string of at most 1024 characters');
  });

  it('keeps U+0000 and unpaired surrogates in context strings, which are evaluated but not stored', () => {
    const input = { key: '\uD800', attributes: { plan: 'a\u0000b' } };
    expect(validateContext(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ['a numeric key', { key: 7 }, 'key: must be'],
    ['a numeric attribute value', { key: 'u', attributes: { age: 30 } }, 'attributes["age"]'],
    ['attributes as an array', { key: 'u', attributes: ['us'] }, 'attributes: must be'],
    ['an unknown property', { key: 'u', email: 'a@b' }, '"email": unknown property'],
  ])('rejects %s', (_name, input, message) => {
    expect(errorsOf(validateContext(input)).join('\n')).toContain(message);
  });
});
