// Tests for scripts/check-claims.mjs. The fixture project in fixtures/claims is a
// real Vitest project: beforeAll copies it to a temporary directory and runs
// Vitest on it, so every case is checked against a report in the format this
// Vitest version writes.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkClaims, parseClaimTables, splitCells } from '../check-claims.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = path.join(repoRoot, 'scripts', 'test', 'fixtures', 'claims');
const script = path.join(repoRoot, 'scripts', 'check-claims.mjs');

let root;
let reportPath;

function environmentWithoutVitest() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')),
  );
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'check-claims-'));
  cpSync(fixture, root, { recursive: true });
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  reportPath = path.join(root, 'report.json');
  const project = path.join(root, 'project');
  const run = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      path.join(project, 'vitest.config.mjs'),
      '--root',
      project,
    ],
    {
      cwd: project,
      encoding: 'utf8',
      env: { ...environmentWithoutVitest(), CLAIMS_FIXTURE_REPORT: reportPath },
    },
  );
  // The fixture project contains a failing test and a file that fails to load, so
  // Vitest exits 1. Anything else means the fixture run itself went wrong.
  if (run.status !== 1) {
    throw new Error(`fixture run exited ${run.status}: ${run.stderr}`);
  }
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function runScript(doc) {
  return spawnSync(
    process.execPath,
    [script, '--root', root, '--report', reportPath, path.join(root, 'docs', doc)],
    { encoding: 'utf8' },
  );
}

function check(doc, options = {}) {
  return checkClaims({ root, reportPath, files: [path.join(root, 'docs', doc)], ...options });
}

describe('check-claims', () => {
  it('passes rows whose linked tests passed, with backticks, fragments and describe titles', () => {
    expect(check('passing.md')).toEqual({
      errors: [],
      rows: 3,
      links: 4,
      startTime: expect.any(Number),
    });
  });

  it.each([
    ['skipped.md', 'docs/skipped.md:3: "is skipped": the test is skipped, not passed'],
    ['todo.md', 'docs/todo.md:3: "is a todo": the test is todo, not passed'],
    ['failed.md', 'docs/failed.md:3: "fails": the test is failed, not passed'],
    [
      'renamed.md',
      'docs/renamed.md:3: "adds 2 numbers": no test with this name in project/tests/sample.test.mjs (renamed or removed?)',
    ],
    [
      'errored.md',
      'docs/errored.md:3: "never registers": project/tests/broken.test.mjs reported an error: fixture: this file fails to load',
    ],
    [
      'not-run.md',
      'docs/not-run.md:3: "is excluded from the run": project/tests/excluded.test.mjs did not run in this report',
    ],
    [
      'missing-file.md',
      'docs/missing-file.md:3: "adds two numbers": file not found: project/tests/gone.test.mjs',
    ],
    [
      'file-link.md',
      'docs/file-link.md:3: "sample.test.mjs": the link names the file project/tests/sample.test.mjs, not a test in it',
    ],
    [
      'blank-row.md',
      'docs/blank-row.md:5: a table row outside a table; a blank line or a missing delimiter row splits the table',
    ],
    ['missing-pipe.md', 'docs/missing-pipe.md:4: a table row without a leading pipe'],
    [
      'text-outside.md',
      'docs/text-outside.md:3: the Test cell has text outside its links: "`#fails`"',
    ],
    ['no-link.md', 'docs/no-link.md:3: the Test cell links no test'],
    [
      'duplicate.md',
      'docs/duplicate.md:3: "shares a name": 2 tests share this name in project/tests/duplicate.test.mjs',
    ],
  ])('fails on %s', (doc, message) => {
    expect(check(doc).errors).toContain(message);
  });

  it('fails when no claim table is found', () => {
    expect(check('no-claims.md').errors).toEqual(['found 0 claim rows, expected at least 1']);
  });

  it('fails on a report older than the maximum age', () => {
    const { errors } = check('passing.md', { now: Date.now() + 61 * 60_000 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^the report is stale: the run started 6\d minutes ago, more than 60/,
    );
  });

  it('fails when a linked test file changed after the report was written', () => {
    const changed = path.join(root, 'project', 'tests', 'sample.test.mjs');
    const later = new Date(Date.now() + 60_000);
    utimesSync(changed, later, later);
    try {
      expect(check('failed.md').errors).toEqual([
        'docs/failed.md:3: "fails": project/tests/sample.test.mjs changed after the report was written; run the tests again',
      ]);
    } finally {
      const earlier = new Date(Date.now() - 3_600_000);
      utimesSync(changed, earlier, earlier);
    }
  });

  it('fails when a source file changed after the report was written', () => {
    const source = path.join(root, 'project', 'lib', 'sum.mjs');
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, 'export const sum = (a, b) => a + b;\n');
    const earlier = new Date(Date.now() - 3_600_000);
    utimesSync(source, earlier, earlier);
    try {
      expect(check('passing.md', { sources: ['project'] }).errors).toEqual([]);
      const later = new Date(Date.now() + 60_000);
      utimesSync(source, later, later);
      expect(check('passing.md', { sources: ['project'] }).errors).toEqual([
        'the report is stale: project/lib/sum.mjs changed after the run started; run the tests again',
      ]);
    } finally {
      rmSync(path.dirname(source), { recursive: true, force: true });
    }
  });

  it('fails when the report is missing or is not a Vitest report', () => {
    const missing = path.join(root, 'missing.json');
    expect(check('passing.md', { reportPath: missing }).errors).toEqual([
      `no test report at ${missing}; run the tests first`,
    ]);
    const other = path.join(root, 'other.json');
    writeFileSync(other, '{"tests": []}');
    expect(check('passing.md', { reportPath: other }).errors).toEqual([
      `${other} is not a Vitest JSON report`,
    ]);
  });

  it('exits 0 on passing claims and 1 with the reasons on failing ones', () => {
    const passing = runScript('passing.md');
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toMatch(
      /^check-claims: 3 claim rows, 4 linked tests, all passed in the test run started at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/,
    );

    const failing = runScript('todo.md');
    expect(failing.status).toBe(1);
    expect(failing.stderr).toBe(
      'check-claims: docs/todo.md:3: "is a todo": the test is todo, not passed\n',
    );
  });
});

describe('check-claims table parsing', () => {
  it('splits cells on unescaped pipes only', () => {
    expect(splitCells('| a | b \\| c | `d` |')).toEqual(['a', 'b | c', '`d`']);
  });

  it('ignores tables inside code fences and tables without a Test column', () => {
    const markdown = [
      '```',
      '| Claim | Test |',
      '| --- | --- |',
      '| x | y |',
      '```',
      '',
      '| Claim | Notes |',
      '| --- | --- |',
      '| x | y |',
    ].join('\n');
    expect(parseClaimTables(markdown, 'x.md')).toEqual({ rows: [], errors: [] });
  });
});
