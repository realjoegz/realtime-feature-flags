import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { END_MARKER, NO_RUNS, START_MARKER } from '../src/readme-table.ts';
import { resultsFileName, serializeResults } from '../src/results.ts';
import { exampleResults } from './support/example-results.ts';

// npm run check:latency and npm run latency:render run the build of render-main.ts.
// The tests run its source with Node, which strips the types, on README files and
// results directories of their own.

const RENDER_MAIN = fileURLToPath(new URL('../src/render-main.ts', import.meta.url));
const README = `# Title\n\n## Latency\n\n${START_MARKER}\n${NO_RUNS}\n${END_MARKER}\n\n## Next\n`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(readme: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rff-latency-render-'));
  roots.push(root);
  writeFileSync(path.join(root, 'README.md'), readme);
  if (Object.keys(files).length > 0) {
    mkdirSync(path.join(root, 'bench/results'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(root, 'bench/results', name), text);
    }
  }
  return root;
}

function run(mode: '--check' | '--write', root: string) {
  const result = spawnSync(process.execPath, [RENDER_MAIN, mode, '--root', root], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const results = exampleResults({
  startedAt: '2026-10-14T18:00:05.123Z',
  warmup: [[9, 9]],
  measured: [
    [3, 1],
    [4, 2],
  ],
});
const resultsFiles = { [resultsFileName(results.startedAt)]: serializeResults(results) };

describe('npm run check:latency', () => {
  it('exits 1 when the placeholder is edited with no results files, when the table differs from the results files, and when bench/results holds another file, and exits 0 for a README that latency:render wrote', () => {
    expect(run('--check', repository(README))).toEqual({
      status: 0,
      output: 'check-latency: README.md holds the rendering of 0 results files\n',
    });
    const edited = run(
      '--check',
      repository(README.replace(NO_RUNS, 'Median 1 ms to every client.')),
    );
    expect(edited.status).toBe(1);
    expect(edited.output).toContain('differs from the rendering of 0 results files at its line 1');

    const root = repository(README, resultsFiles);
    expect(run('--check', root).status).toBe(1);
    expect(run('--write', root)).toEqual({
      status: 0,
      output: 'render-latency: README.md holds the rendering of 1 results files\n',
    });
    const rendered = readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(rendered).toContain('| 3.0, 3.5, 4.0, 4.0 |');
    expect(run('--check', root).status).toBe(0);

    const changed = run(
      '--check',
      repository(
        rendered.replace('| 3.0, 3.5, 4.0, 4.0 |', '| 3.0, 3.5, 4.0, 3.9 |'),
        resultsFiles,
      ),
    );
    expect(changed.status).toBe(1);
    expect(changed.output).toContain('differs from the rendering of 1 results files at its line 3');

    const stray = run('--check', repository(rendered, { ...resultsFiles, 'notes.txt': 'a note' }));
    expect(stray.status).toBe(1);
    expect(stray.output).toContain('bench/results/notes.txt is not a results file');
  });
});
