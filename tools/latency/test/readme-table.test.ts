import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  END_MARKER,
  latencyMismatch,
  NO_RUNS,
  readRuns,
  renderLatency,
  START_MARKER,
  withLatencyBlock,
} from '../src/readme-table.ts';
import {
  type LatencyResults,
  parseResults,
  resultsFileName,
  serializeResults,
} from '../src/results.ts';
import { exampleResults, type Times } from './support/example-results.ts';

const README = `# Title\n\nIntro.\n\n## Latency\n\n${START_MARKER}\nold text\n${END_MARKER}\n\n## Next\n`;

const directories: string[] = [];

function resultsDirectory(runs: readonly LatencyResults[], extra: Record<string, string> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rff-latency-test-'));
  directories.push(directory);
  const results = path.join(directory, 'results');
  mkdirSync(results);
  for (const run of runs) {
    writeFileSync(path.join(results, resultsFileName(run.startedAt)), serializeResults(run));
  }
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(results, name), text);
  return results;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const oneToTwenty: Times[] = Array.from({ length: 20 }, (_, index) => [index + 1, (index + 1) / 2]);

const earlier = exampleResults({
  startedAt: '2026-10-14T18:00:05.123Z',
  warmup: [
    [999, 888],
    [998, 887],
  ],
  measured: oneToTwenty,
});

const laterTimes = exampleResults({
  startedAt: '2026-10-14T18:30:00.000Z',
  measured: [
    [100, 3],
    [300, 1],
    [200, 2],
  ],
});
const later: LatencyResults = {
  ...laterTimes,
  phases: {
    ...laterTimes.phases,
    measured: {
      ...laterTimes.phases.measured,
      reconnects: 1,
      otherDeliveries: { connect: 1, ready: 0, poll: 2 },
    },
  },
};

describe('README latency table', () => {
  it('with no results files the section between the markers is one line saying that no run is committed', () => {
    const directory = resultsDirectory([]);
    expect(readRuns(path.join(directory, 'missing'))).toEqual([]);
    const runs = readRuns(directory);
    expect(renderLatency(runs)).toBe(NO_RUNS);
    const readme = withLatencyBlock(README, renderLatency(runs));
    expect(readme).toBe(README.replace('old text', NO_RUNS));
    expect(latencyMismatch(readme, runs)).toBeNull();
  });

  it("renders one row per results file, oldest first, with min, median, p95 and max of that run's measured changes only, never averaged across runs, its reconnects and deliveries not brought by a notification, and the conditions all runs share once", () => {
    const runs = readRuns(resultsDirectory([later, earlier]));
    expect(runs.map((run) => run.file)).toEqual([
      'latency-20261014T180005Z.json',
      'latency-20261014T183000Z.json',
    ]);
    expect(renderLatency(runs)).toBe(
      [
        '| Run (UTC) | Clients | Changes | To the last client (ms): min, median, p95, max | Save round trip (ms): min, median, p95, max | Reconnects | Not by notification |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| [2026-10-14 18:00:05](bench/results/latency-20261014T180005Z.json) | 50: 25 on api-1, 25 on api-2 | 20 after 2 warm-up | 1.0, 10.5, 19.0, 20.0 | 0.5, 5.3, 9.5, 10.0 | 0 | 0 |',
        '| [2026-10-14 18:30:00](bench/results/latency-20261014T183000Z.json) | 50: 25 on api-1, 25 on api-2 | 3 after 0 warm-up | 100.0, 200.0, 300.0, 300.0 | 1.0, 2.0, 3.0, 3.0 | 1 | 3 (connect 1, poll 2) |',
        '',
        "Conditions: MacBook Air (Mac16,12), Apple M4, 10 cores, 16 GiB, macOS 26.6.2; Colima 0.10.3 with 6 CPUs, 8 GiB, aarch64; Node 24.13.0, PostgreSQL 18.6, Redis 8.10.2, Docker 29.5.2; open-file limit 61440 in the measuring process; 1 tenant with 3 flags and a 531-byte snapshot; clients in the Node process on the host that sends the saves, each connected directly to its replica's published port; every save a PUT of dark-mode to api-1; safety poll every 30 s; commit 0123456. Reconnects and deliveries that no Redis notification brought are counted over the measured changes.",
      ].join('\n'),
    );
  });

  it('writes a condition that differs between runs once per run, labelled with the run', () => {
    const other = {
      ...later,
      commit: { sha: 'fedcba9876543210fedcba9876543210fedcba98', clean: false },
    };
    const conditions = renderLatency(readRuns(resultsDirectory([earlier, other])))
      .split('\n')
      .at(-1);
    expect(conditions).toContain(
      '; commit 0123456 (run 2026-10-14 18:00:05), commit fedcba9 with uncommitted changes (run 2026-10-14 18:30:00).',
    );
    expect(conditions).toContain('; open-file limit 61440 in the measuring process;');
  });

  it('the check fails when the section differs from the rendering, when a marker is missing or repeated, and when bench/results holds an invalid results file or another file', () => {
    const runs = readRuns(resultsDirectory([earlier]));
    const rendered = withLatencyBlock(README, renderLatency(runs));
    expect(latencyMismatch(rendered, runs)).toBeNull();
    expect(latencyMismatch(rendered.replace('19.0, 20.0', '19.0, 21.0'), runs)).toMatch(
      /differs from the rendering of 1 results files at its line 3/,
    );
    expect(latencyMismatch(withLatencyBlock(README, NO_RUNS), runs)).toMatch(/at its line 1/);
    expect(latencyMismatch(rendered, [])).toMatch(/differs/);
    expect(latencyMismatch(rendered.replace(`${END_MARKER}\n`, ''), runs)).toMatch(/once each/);
    expect(latencyMismatch(`${rendered}\n${START_MARKER}\n`, runs)).toMatch(/once each/);

    const broken: [string, string, RegExp][] = [
      ['latency-20261014T180005Z.json', '{', /not JSON/],
      [
        'latency-20261014T180005Z.json',
        serializeResults({
          ...earlier,
          phases: { ...earlier.phases, warmup: { ...earlier.phases.warmup, changes: 3 } },
        }),
        /phases\.warmup\.changes is 3, but changes lists 2/,
      ],
      [
        'latency-20261014T180005Z.json',
        serializeResults({ ...earlier, clients: { ...earlier.clients, count: 51 } }),
        /byReplica does not add up/,
      ],
      [
        'latency-20261014T180005Z.json',
        serializeResults({
          ...earlier,
          command: 'npm run latency -- --clients 50 --warmup 0 --changes 22',
        }),
        /command gives --warmup 0, but the run has 2/,
      ],
      [
        'latency-20261014T180005Z.json',
        serializeResults({
          ...earlier,
          command: 'npm run latency -- --clients=60 --warmup 2 --changes 20',
        }),
        /command gives --clients 60, but the run has 50/,
      ],
      [
        'latency-20261014T180005Z.json',
        serializeResults({
          ...earlier,
          openFileLimit: { ...earlier.openFileLimit, soft: 'many' },
        }),
        /openFileLimit\.soft is not a number of files or unlimited/,
      ],
      [
        'latency-20261014T190000Z.json',
        serializeResults(earlier),
        /holds a run that started at 2026-10-14T18:00:05.123Z/,
      ],
      ['notes.txt', 'a note', /bench\/results\/notes\.txt is not a results file/],
    ];
    for (const [name, text, error] of broken) {
      expect(() => readRuns(resultsDirectory([], { [name]: text }))).toThrow(error);
    }
  });

  it('a results file reads back as the results that were written, with one change per line', () => {
    const text = serializeResults(earlier);
    expect(parseResults(text)).toEqual(earlier);
    const changeLines = text.split('\n').filter((line) => line.startsWith('    {"phase":'));
    expect(changeLines).toHaveLength(earlier.changes.length);
    expect(resultsFileName(earlier.startedAt)).toBe('latency-20261014T180005Z.json');
  });
});
