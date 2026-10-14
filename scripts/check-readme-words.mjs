#!/usr/bin/env node
// Fails when README.md has more than 1,500 words. A word is a run of characters
// between ASCII whitespace (space, tab, newline, vertical tab, form feed, carriage
// return); other characters, U+00A0 and U+2003 among them, are part of a word.
// For text whose whitespace is all ASCII this is the count `wc -w` gives in the C
// locale. Markdown syntax counts as written.
//
//   node scripts/check-readme-words.mjs [--max N] [FILE]

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
export const DEFAULT_MAX_WORDS = 1500;

/**
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  return text.split(/[ \t\n\v\f\r]+/).filter((word) => word !== '').length;
}

/**
 * @param {string[]} argv
 * @returns {{ max: number, file: string }}
 */
function parseArguments(argv) {
  let max = DEFAULT_MAX_WORDS;
  let file = DEFAULT_FILE;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (argument === '--max') {
      max = Number(argv[++index]);
      if (!Number.isInteger(max) || max < 0) throw new Error('--max needs a whole number');
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${argument}`);
    } else {
      file = path.resolve(argument);
    }
  }
  return { max, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { max, file } = parseArguments(process.argv.slice(2));
  const words = countWords(readFileSync(file, 'utf8'));
  const relative = path.relative(process.cwd(), realpathSync(file));
  const name = relative.startsWith('..') ? file : relative;
  if (words > max) {
    console.error(`check-readme-words: ${name} has ${words} words, more than ${max}`);
    process.exit(1);
  }
  console.log(`check-readme-words: ${name} has ${words} words, at most ${max}`);
}
