// Small shared pools for attribute names and values. Generators draw rules and
// contexts from the same pools, so rules match often, several rules can match one
// context, and some attributes are missing. The pools include names inherited from
// Object.prototype, non-ASCII text, and near misses: strings that differ from
// another pool entry only in case, surrounding spaces or Unicode normalization.
// Names and values compare exactly, so an evaluator that folds case, trims or
// normalizes gives a different result on them.

export const ATTRIBUTE_NAMES = [
  'country',
  'Country',
  'country ',
  'plan',
  'beta',
  'région',
  're\u0301gion',
  'constructor',
  '__proto__',
] as const;

export const ATTRIBUTE_VALUES = [
  'us',
  'US',
  ' us',
  'us ',
  'gb',
  'de',
  'pro',
  'free',
  '',
  'true',
  'ü',
  'u\u0308',
  '日本',
] as const;

/** A string folded the way a lenient evaluator might compare it. */
function fold(text: string): string {
  return text.normalize('NFC').trim().toLowerCase();
}

/** Strings one case change, surrounding space or normalization away from `text`. */
export function nearMisses(text: string): string[] {
  const variants = [
    text.toUpperCase(),
    text.toLowerCase(),
    ` ${text}`,
    `${text} `,
    text.normalize('NFD'),
    text.normalize('NFC'),
  ];
  return [...new Set(variants)].filter((variant) => variant !== text);
}

/** Whether two names are equal once case, surrounding spaces and normalization are ignored. */
export function sameAfterFolding(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** User keys that exercise UTF-8: two-, three- and four-byte characters and combining marks. */
export const NON_ASCII_KEYS = ['ü', 'π', 'ππππππππ', '日本語', 'user-🚀', 'é', 'Ωmega-42'] as const;

/** Unpaired UTF-16 surrogates. TextEncoder writes each as U+FFFD (EF BF BD). */
export const LONE_SURROGATE_KEYS = ['\uD800', 'user-\uDFFF', '\uDBFF\uDBFFx'] as const;
