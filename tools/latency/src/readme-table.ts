import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { totalDeliveries } from './deliveries.ts';
import {
  type LatencyResults,
  OTHER_CAUSES,
  type OtherDeliveries,
  openFiles,
  parseResults,
  RESULTS_FILE_PATTERN,
  resultsFileName,
} from './results.ts';
import { summarize, type Summary } from './stats.ts';

// The latency section of README.md: between the two markers below stands the
// rendering of every results file in bench/results, one table row per run, each
// with its own numbers. Runs are never averaged together. npm run verify fails when
// the README holds anything else there (render-main.ts --check).

export const START_MARKER = '<!-- latency:start -->';
export const END_MARKER = '<!-- latency:end -->';
export const RESULTS_DIRECTORY = 'bench/results';
export const NO_RUNS = 'No latency run is committed yet.';

export interface Run {
  /** The file name in bench/results. */
  readonly file: string;
  readonly results: LatencyResults;
}

/** Every results file in directory, oldest run first; an error for any other file or an invalid one. */
export function readRuns(directory: string): Run[] {
  if (!existsSync(directory)) return [];
  const runs: Run[] = [];
  for (const file of readdirSync(directory).toSorted()) {
    const shown = `${RESULTS_DIRECTORY}/${file}`;
    if (!RESULTS_FILE_PATTERN.test(file)) {
      throw new Error(`${shown} is not a results file: names are latency-YYYYMMDDTHHMMSSZ.json`);
    }
    let results: LatencyResults;
    try {
      results = parseResults(readFileSync(path.join(directory, file), 'utf8'));
    } catch (error) {
      throw new Error(`${shown} is not valid: ${(error as Error).message}`, { cause: error });
    }
    if (resultsFileName(results.startedAt) !== file) {
      throw new Error(`${shown} holds a run that started at ${results.startedAt}`);
    }
    runs.push({ file, results });
  }
  return runs.toSorted((a, b) => compare(a.results.startedAt, b.results.startedAt));
}

/** The Markdown between the markers for these runs. */
export function renderLatency(runs: readonly Run[]): string {
  if (runs.length === 0) return NO_RUNS;
  const header = [
    'Run (UTC)',
    'Clients',
    'Changes',
    'To the last client (ms): min, median, p95, max',
    'Save round trip (ms): min, median, p95, max',
    'Reconnects',
    'Not by notification',
  ];
  const rows = runs.map(({ file, results }) => {
    const measured = results.changes.filter((change) => change.phase === 'measured');
    const phase = results.phases.measured;
    return [
      `[${runLabel(results)}](${RESULTS_DIRECTORY}/${file})`,
      clientsText(results),
      `${phase.changes} after ${results.phases.warmup.changes} warm-up`,
      summaryText(summarize(measured.map((change) => change.lastClientMs))),
      summaryText(summarize(measured.map((change) => change.saveMs))),
      String(phase.reconnects),
      deliveriesText(phase.otherDeliveries),
    ];
  });
  const table = [header, header.map(() => '---'), ...rows].map(
    (cells) => `| ${cells.join(' | ')} |`,
  );
  return [
    ...table,
    '',
    `Conditions: ${conditions(runs)}. Reconnects and deliveries that no Redis notification brought are counted over the measured changes.`,
  ].join('\n');
}

/** The text between the markers, without the line breaks that follow and precede them. */
export function latencyBlock(readme: string): string {
  const { start, end } = markers(readme);
  return readme.slice(start + START_MARKER.length + 1, end - 1);
}

/** readme with block between the markers. */
export function withLatencyBlock(readme: string, block: string): string {
  const { start, end } = markers(readme);
  return `${readme.slice(0, start + START_MARKER.length)}\n${block}\n${readme.slice(end)}`;
}

/** Why readme does not hold the rendering of runs, or null when it does. */
export function latencyMismatch(readme: string, runs: readonly Run[]): string | null {
  let block: string;
  try {
    block = latencyBlock(readme);
  } catch (error) {
    return (error as Error).message;
  }
  const expected = renderLatency(runs);
  if (block === expected) return null;
  const got = block.split('\n');
  const want = expected.split('\n');
  const line = want.findIndex((text, index) => got[index] !== text);
  const at = line === -1 ? want.length : line;
  return `the latency section differs from the rendering of ${runs.length} results files at its line ${at + 1}: expected ${JSON.stringify(want[at] ?? '(the end)')}, found ${JSON.stringify(got[at] ?? '(the end)')}`;
}

function markers(readme: string): { start: number; end: number } {
  const lines = readme.split('\n');
  const starts = lines.filter((line) => line === START_MARKER).length;
  const ends = lines.filter((line) => line === END_MARKER).length;
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `README.md needs ${START_MARKER} and ${END_MARKER} once each, on lines of their own; it has ${starts} and ${ends}`,
    );
  }
  const start = readme.indexOf(`${START_MARKER}\n`);
  const end = readme.indexOf(`\n${END_MARKER}`) + 1;
  if (start === -1 || end <= start)
    throw new Error(`${END_MARKER} must come after ${START_MARKER}`);
  return { start, end };
}

/** Code unit order, the same in every locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function runLabel(results: LatencyResults): string {
  return results.startedAt.slice(0, 19).replace('T', ' ');
}

function ms(value: number): string {
  return value.toFixed(1);
}

function summaryText(summary: Summary): string {
  return [summary.min, summary.median, summary.p95, summary.max].map(ms).join(', ');
}

function clientsText(results: LatencyResults): string {
  const split = Object.entries(results.clients.byReplica)
    .toSorted(([a], [b]) => compare(a, b))
    .map(([replica, clients]) => `${clients} on ${replica}`);
  return `${results.clients.count}: ${split.join(', ')}`;
}

function deliveriesText(deliveries: OtherDeliveries): string {
  const total = totalDeliveries(deliveries);
  if (total === 0) return '0';
  const parts = OTHER_CAUSES.filter((cause) => deliveries[cause] > 0).map(
    (cause) => `${cause} ${deliveries[cause]}`,
  );
  return `${total} (${parts.join(', ')})`;
}

function bytes(value: number): string {
  const gib = value / 2 ** 30;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function machineText({ machine }: LatencyResults): string {
  const name = [machine.name, machine.model === null ? null : `(${machine.model})`]
    .filter((part) => part !== null)
    .join(' ');
  return [
    name,
    machine.cpu,
    plural(machine.cores, 'core', 'cores'),
    bytes(machine.memoryBytes),
    machine.os,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

function seconds(value: number): string {
  return value % 1000 === 0 ? `${value / 1000} s` : `${value} ms`;
}

/** Each condition of a run as a phrase, in the order the sentence gives them. */
const CONDITIONS: readonly ((results: LatencyResults) => string)[] = [
  machineText,
  ({ colima }) =>
    colima === null
      ? 'no Colima'
      : `Colima ${colima.version} with ${plural(colima.cpus, 'CPU', 'CPUs')}, ${bytes(colima.memoryBytes)}, ${colima.arch}`,
  ({ versions }) =>
    `Node ${versions.node}, PostgreSQL ${versions.postgres}, Redis ${versions.redis}, Docker ${versions.docker}`,
  ({ openFileLimit }) => `open-file limit ${openFiles(openFileLimit)} in the measuring process`,
  ({ workload }) =>
    `${plural(workload.tenants, 'tenant', 'tenants')} with ${plural(workload.flagsPerTenant, 'flag', 'flags')} and a ${workload.snapshotBytes}-byte snapshot`,
  ({ clients }) => `clients in ${clients.ranIn}`,
  ({ stack, workload }) => `every save a PUT of ${workload.flagKey} to ${stack.saveTo}`,
  ({ stack }) => `safety poll every ${seconds(stack.safetyPollMs)}`,
  ({ commit }) =>
    `commit ${commit.sha.slice(0, 7)}${commit.clean ? '' : ' with uncommitted changes'}`,
];

/** The conditions joined by semicolons: once when every run shares it, else per run. */
function conditions(runs: readonly Run[]): string {
  return CONDITIONS.map((condition) => {
    const phrases = runs.map(({ results }) => condition(results));
    if (phrases.every((phrase) => phrase === phrases[0])) return phrases[0] as string;
    return phrases
      .map((phrase, index) => `${phrase} (run ${runLabel(runs[index]!.results)})`)
      .join(', ');
  }).join('; ');
}
