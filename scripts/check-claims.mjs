#!/usr/bin/env node
// Checks that every claim in the docs is backed by a test that ran and passed.
//
// It reads the Markdown tables in README.md and docs/*.md that have a "Test"
// column. Each row's Test cell must link one or more test files, with the full
// test name (describe titles and test title, joined by spaces) as the link text.
// Every linked test must appear in this run's Vitest JSON report with the status
// "passed". A failed, skipped, todo, missing or renamed test fails the check, and
// so does a missing file, a file that failed to load, a link that names a file
// instead of a test, a table row the parser would otherwise drop, and a report
// that is older than --max-age-minutes or older than a linked test file or any
// file under packages/, apps/, tools/ or scripts/ or vitest.config.ts.
//
//   node scripts/check-claims.mjs [--root DIR] [--report FILE] [--max-age-minutes N]
//                                 [--min-rows N] [FILE.md ...]

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ text: string, target: string }} Link
 * @typedef {{ line: number, links: Link[] }} ClaimRow
 * @typedef {{ fullName: string, status: string }} AssertionResult
 * @typedef {{ name: string, status: string, message: string, assertionResults: AssertionResult[] }} FileResult
 * @typedef {{ startTime: number, testResults: FileResult[] }} Report
 * @typedef {{ root?: string, reportPath?: string, files?: string[], maxAgeMinutes?: number,
 *             minRows?: number, now?: number, sources?: string[] }} CheckOptions
 */

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT = '.vitest/report.json';
const DEFAULT_MAX_AGE_MINUTES = 60;
const TEST_HEADERS = new Set(['test', 'tests']);
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const FENCE = /^(```|~~~)/;
const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;
// The code the tests run. A file here that changed after the report was written
// means the report may not describe the current code.
const DEFAULT_SOURCES = ['packages', 'apps', 'tools', 'scripts', 'vitest.config.ts'];
// Build output and installed packages, which change without a source change.
const SKIPPED_NAMES = new Set(['node_modules', 'dist', 'coverage']);

/**
 * README.md (when present) and every docs/*.md, in a stable order.
 * @param {string} root
 * @returns {string[]}
 */
export function defaultMarkdownFiles(root) {
  const files = [];
  if (existsSync(path.join(root, 'README.md'))) files.push(path.join(root, 'README.md'));
  const docs = path.join(root, 'docs');
  if (existsSync(docs)) {
    for (const name of readdirSync(docs).toSorted()) {
      if (name.endsWith('.md')) files.push(path.join(docs, name));
    }
  }
  return files;
}

/**
 * Splits a table row on unescaped pipes, as GitHub does, and trims each cell.
 * @param {string} line
 * @returns {string[]}
 */
export function splitCells(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index++;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * The links in a Test cell, and an error when the cell has no link or has text
 * outside its links (a test named that way would not be checked).
 * @param {string} cell
 * @returns {{ links: Link[], problem?: string }}
 */
function parseTestCell(cell) {
  const links = [...cell.matchAll(LINK)].map((match) => ({
    text: (match[1] ?? '').replace(/`/g, '').trim(),
    target: match[2] ?? '',
  }));
  const outside = cell
    .replace(LINK, ' ')
    .split(/[\s,;]+|<br\s*\/?>/)
    .filter((word) => word !== '' && word !== 'and');
  if (links.length === 0) return { links, problem: 'the Test cell links no test' };
  if (outside.length > 0) {
    return {
      links,
      problem: `the Test cell has text outside its links: ${JSON.stringify(outside.join(' '))}`,
    };
  }
  return { links };
}

/**
 * Finds the rows of tables with a Test column and the links in their Test cells.
 * @param {string} markdown
 * @param {string} label the file name used in messages
 * @returns {{ rows: ClaimRow[], errors: string[] }}
 */
export function parseClaimTables(markdown, label) {
  const lines = markdown.split(/\r?\n/);
  /** @type {ClaimRow[]} */
  const rows = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string | null} */
  let fence = null;
  let index = 0;

  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trim();
    const fenceMatch = FENCE.exec(trimmed);
    if (fence !== null) {
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
      index++;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? null;
      index++;
      continue;
    }

    const next = (lines[index + 1] ?? '').trim();
    const isTableStart = trimmed.includes('|') && next.includes('-') && DELIMITER_ROW.test(next);
    if (!isTableStart) {
      if (trimmed.startsWith('|')) {
        errors.push(
          `${label}:${index + 1}: a table row outside a table; a blank line or a missing delimiter row splits the table`,
        );
      }
      index++;
      continue;
    }

    if (!trimmed.startsWith('|')) {
      errors.push(`${label}:${index + 1}: a table header without a leading pipe`);
    }
    const header = splitCells(trimmed).map((cell) => cell.toLowerCase());
    const testColumn = header.findIndex((cell) => TEST_HEADERS.has(cell));
    index += 2;

    while (index < lines.length) {
      const rowText = (lines[index] ?? '').trim();
      if (rowText === '' || FENCE.test(rowText)) break;
      const lineNumber = index + 1;
      index++;
      if (!rowText.startsWith('|')) {
        errors.push(`${label}:${lineNumber}: a table row without a leading pipe`);
        continue;
      }
      if (testColumn === -1) continue;

      const { links, problem } = parseTestCell(splitCells(rowText)[testColumn] ?? '');
      if (problem !== undefined) errors.push(`${label}:${lineNumber}: ${problem}`);
      rows.push({ line: lineNumber, links });
    }
  }
  return { rows, errors };
}

/** @param {string} file */
function toPosix(file) {
  return file.split(path.sep).join('/');
}

/**
 * A path relative to the root, with symbolic links resolved on both sides
 * (on macOS the temporary directory is /var, which links to /private/var).
 * @param {string} realRoot
 * @param {string} file
 */
function relativeTo(realRoot, file) {
  let existing = path.resolve(file);
  /** @type {string[]} */
  const missing = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return toPosix(path.relative(realRoot, path.join(realpathSync(existing), ...missing)));
}

/**
 * Indexes the report by file path relative to the root.
 * @param {Report} report
 * @param {string} realRoot
 * @returns {Map<string, FileResult>}
 */
function indexReport(report, realRoot) {
  const byFile = new Map();
  for (const result of report.testResults) {
    const name = path.isAbsolute(result.name)
      ? relativeTo(realRoot, result.name)
      : toPosix(path.normalize(result.name));
    byFile.set(name, result);
  }
  return byFile;
}

/**
 * The most recently changed file under the given paths, skipping build output,
 * installed packages and names that start with ".".
 * @param {string} root
 * @param {string[]} sources paths relative to the root
 * @returns {{ file: string, mtimeMs: number } | undefined}
 */
function newestSourceFile(root, sources) {
  /** @type {{ file: string, mtimeMs: number } | undefined} */
  let newest;
  /** @param {string} file */
  const visit = (file) => {
    const stats = statSync(file);
    if (stats.isDirectory()) {
      for (const name of readdirSync(file)) {
        if (!SKIPPED_NAMES.has(name) && !name.startsWith('.') && !name.endsWith('.tsbuildinfo')) {
          visit(path.join(file, name));
        }
      }
    } else if (stats.isFile() && (newest === undefined || stats.mtimeMs > newest.mtimeMs)) {
      newest = { file, mtimeMs: stats.mtimeMs };
    }
  };
  for (const source of sources) {
    const file = path.join(root, source);
    if (existsSync(file)) visit(file);
  }
  return newest;
}

/**
 * @param {string} reportPath
 * @returns {{ report: Report, error?: undefined } | { report?: undefined, error: string }}
 */
function readReport(reportPath) {
  if (!existsSync(reportPath)) {
    return { error: `no test report at ${reportPath}; run the tests first` };
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(report.testResults) || typeof report.startTime !== 'number') {
      return { error: `${reportPath} is not a Vitest JSON report` };
    }
    return { report };
  } catch (error) {
    return { error: `${reportPath} is not valid JSON: ${String(error)}` };
  }
}

/**
 * Why one linked test does not back its claim, or undefined when it does.
 * @param {Link} link
 * @param {string} markdownFile
 * @param {string} realRoot
 * @param {Report} report
 * @param {Map<string, FileResult>} byFile
 * @returns {string | undefined}
 */
function problemWithLink({ text, target }, markdownFile, realRoot, report, byFile) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return `links ${target}, not a test file in this repository`;
  }
  const targetPath = path.resolve(
    path.dirname(markdownFile),
    decodeURIComponent(target.split('#')[0] ?? ''),
  );
  const relative = relativeTo(realRoot, targetPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    return `file not found: ${relative}`;
  }
  if (text === '' || text === target || text === relative || text === path.basename(targetPath)) {
    return `the link names the file ${relative}, not a test in it`;
  }
  if (statSync(targetPath).mtimeMs > report.startTime) {
    return `${relative} changed after the report was written; run the tests again`;
  }
  const result = byFile.get(relative);
  if (result === undefined) return `${relative} did not run in this report`;
  if (result.status === 'failed' && result.message) {
    return `${relative} reported an error: ${result.message.split('\n')[0]}`;
  }
  const matches = result.assertionResults.filter((test) => test.fullName === text);
  const [match] = matches;
  if (match === undefined) return `no test with this name in ${relative} (renamed or removed?)`;
  if (matches.length > 1) return `${matches.length} tests share this name in ${relative}`;
  if (match.status !== 'passed') return `the test is ${match.status}, not passed`;
  return undefined;
}

/**
 * Checks every claim row against the report.
 * @param {CheckOptions} [options]
 * @returns {{ errors: string[], rows: number, links: number, startTime?: number }}
 */
export function checkClaims(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const reportPath = options.reportPath ?? path.join(root, DEFAULT_REPORT);
  const files = options.files ?? defaultMarkdownFiles(root);
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES;
  const minRows = options.minRows ?? 1;
  const now = options.now ?? Date.now();
  const sources = options.sources ?? DEFAULT_SOURCES;

  const { report, error } = readReport(reportPath);
  if (report === undefined) return { errors: [error], rows: 0, links: 0 };
  const realRoot = realpathSync(root);
  const byFile = indexReport(report, realRoot);
  const errors = [];
  let rowCount = 0;
  let linkCount = 0;

  const ageMinutes = (now - report.startTime) / 60_000;
  if (ageMinutes > maxAgeMinutes) {
    errors.push(
      `the report is stale: the run started ${Math.round(ageMinutes)} minutes ago, more than ${maxAgeMinutes}; run the tests again`,
    );
  }
  const newest = newestSourceFile(root, sources);
  if (newest !== undefined && newest.mtimeMs > report.startTime) {
    errors.push(
      `the report is stale: ${relativeTo(realRoot, newest.file)} changed after the run started; run the tests again`,
    );
  }

  for (const file of files) {
    const label = relativeTo(realRoot, file);
    const { rows, errors: tableErrors } = parseClaimTables(readFileSync(file, 'utf8'), label);
    errors.push(...tableErrors);
    rowCount += rows.length;
    for (const row of rows) {
      for (const link of row.links) {
        linkCount++;
        const problem = problemWithLink(link, file, realRoot, report, byFile);
        if (problem !== undefined) errors.push(`${label}:${row.line}: "${link.text}": ${problem}`);
      }
    }
  }

  if (rowCount < minRows) {
    errors.push(`found ${rowCount} claim rows, expected at least ${minRows}`);
  }
  return { errors, rows: rowCount, links: linkCount, startTime: report.startTime };
}

/**
 * @param {string[]} argv
 * @returns {CheckOptions}
 */
function parseArguments(argv) {
  /** @type {CheckOptions} */
  const options = {};
  /** @type {string[]} */
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--report') options.reportPath = path.resolve(value());
    else if (argument === '--max-age-minutes') options.maxAgeMinutes = Number(value());
    else if (argument === '--min-rows') options.minRows = Number(value());
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else files.push(path.resolve(argument));
  }
  if (files.length > 0) options.files = files;
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, rows, links, startTime } = checkClaims(parseArguments(process.argv.slice(2)));
  if (errors.length > 0) {
    for (const message of errors) console.error(`check-claims: ${message}`);
    process.exit(1);
  }
  const started = new Date(startTime ?? 0).toISOString();
  console.log(
    `check-claims: ${rows} claim rows, ${links} linked tests, all passed in the test run started at ${started}`,
  );
}
