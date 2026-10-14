import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { countWords, DEFAULT_MAX_WORDS } from '../check-readme-words.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'words');
const script = path.join(here, '..', 'check-readme-words.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'check-readme-words-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `wc -w` in the C locale, so the count does not depend on the machine's locale. */
function wordCountFromWc(file) {
  const result = spawnSync('wc', ['-w', file], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim().split(/\s+/)[0]);
}

function runChecker(text, ...options) {
  const file = path.join(scratch, 'README.md');
  writeFileSync(file, text);
  return spawnSync(process.execPath, [script, ...options, file], {
    encoding: 'utf8',
    cwd: scratch,
  });
}

describe('check-readme-words', () => {
  it.each([
    ['readme-like.md', 49],
    ['whitespace.txt', 14],
    ['empty.txt', 0],
  ])('counts %s as %i words, the same as wc -w in the C locale', (name, expected) => {
    const file = path.join(fixtures, name);
    expect(countWords(readFileSync(file, 'utf8'))).toBe(expected);
    expect(wordCountFromWc(file)).toBe(expected);
  });

  it('splits only on ASCII whitespace: U+00A0 and U+2003 are part of a word', () => {
    const text = readFileSync(path.join(fixtures, 'unicode-spaces.txt'), 'utf8');
    expect(text).toBe('one\u00A0two three\u2003four five\n');
    expect(countWords(text)).toBe(3);
  });

  it('allows 1,500 words and fails at 1,501', () => {
    expect(DEFAULT_MAX_WORDS).toBe(1500);
    const atLimit = runChecker('word '.repeat(1500));
    expect(atLimit.status, atLimit.stderr).toBe(0);
    expect(atLimit.stdout).toBe('check-readme-words: README.md has 1500 words, at most 1500\n');

    const overLimit = runChecker('word '.repeat(1501));
    expect(overLimit.status).toBe(1);
    expect(overLimit.stderr).toBe('check-readme-words: README.md has 1501 words, more than 1500\n');
  });

  it('takes a different limit with --max', () => {
    expect(runChecker('one two three', '--max', '2').status).toBe(1);
    expect(runChecker('one two', '--max', '2').status).toBe(0);
  });
});
