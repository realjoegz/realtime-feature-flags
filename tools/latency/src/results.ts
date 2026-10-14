// The results file of one run, bench/results/latency-<UTC start>.json. It holds the
// raw time of every change, warm-up included, and the conditions of the run; the
// summaries in the README are computed from it (readme-table.ts), never stored.

export const RESULTS_FORMAT = 1;

export const PHASES = ['warmup', 'measured'] as const;
export type Phase = (typeof PHASES)[number];

/** Snapshots the replicas logged as sent after a wake-up that was not a notification. */
export interface OtherDeliveries {
  readonly connect: number;
  readonly ready: number;
  readonly poll: number;
}

export const OTHER_CAUSES = [
  'connect',
  'ready',
  'poll',
] as const satisfies readonly (keyof OtherDeliveries)[];

export interface PhaseTotals {
  readonly changes: number;
  /** Connections the clients opened after their first one. */
  readonly reconnects: number;
  /** Failures the clients reported through onError. */
  readonly clientErrors: number;
  readonly otherDeliveries: OtherDeliveries;
}

export interface Change {
  readonly phase: Phase;
  readonly version: number;
  /** From just before the PUT was sent to the end of its response, in ms. */
  readonly saveMs: number;
  /** From just before the PUT was sent to the last client's onChange for this version or a later one, in ms. */
  readonly lastClientMs: number;
}

export interface Machine {
  /** The marketing name, such as MacBook Air, where the system reports one. */
  readonly name: string | null;
  /** The model identifier, such as Mac16,12, where the system reports one. */
  readonly model: string | null;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryBytes: number;
  readonly os: string;
}

export interface Colima {
  readonly version: string;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly arch: string;
}

export interface LatencyResults {
  readonly format: typeof RESULTS_FORMAT;
  /** ISO 8601 in UTC. */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly command: string;
  readonly commit: { readonly sha: string; readonly clean: boolean };
  readonly machine: Machine;
  readonly colima: Colima | null;
  readonly versions: {
    readonly node: string;
    readonly postgres: string;
    readonly redis: string;
    readonly docker: string;
  };
  /**
   * The open-file limits of the measuring process: ulimit -n and ulimit -Hn, as Node
   * leaves them after it raises its soft limit towards the hard one at start-up, and
   * on macOS kern.maxfilesperproc, the most files a process can open whatever its
   * limits (null elsewhere).
   */
  readonly openFileLimit: {
    readonly soft: string;
    readonly hard: string;
    readonly maxFilesPerProc: string | null;
  };
  readonly stack: {
    /** Instance name to the URL the clients used. */
    readonly replicas: Readonly<Record<string, string>>;
    /** The instance every save was sent to. */
    readonly saveTo: string;
    readonly safetyPollMs: number;
  };
  readonly workload: {
    readonly tenants: number;
    readonly flagsPerTenant: number;
    /** UTF-8 bytes of the data of one snapshot event. */
    readonly snapshotBytes: number;
    readonly flagKey: string;
  };
  readonly clients: {
    readonly count: number;
    /** Instance name to the number of clients connected to it. */
    readonly byReplica: Readonly<Record<string, number>>;
    /** Where the clients ran, as a phrase: "one Node process on the host, ...". */
    readonly ranIn: string;
  };
  readonly phases: Readonly<Record<Phase, PhaseTotals>>;
  readonly changes: readonly Change[];
}

/** latency-20261014T180203Z.json for a run that started at 2026-10-14T18:02:03.xxxZ. */
export function resultsFileName(startedAt: string): string {
  const compact = startedAt.replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `latency-${compact}.json`;
}

export const RESULTS_FILE_PATTERN = /^latency-\d{8}T\d{6}Z\.json$/;

/** The most files the measuring process could open: its soft limit, capped by kern.maxfilesperproc. */
export function openFiles(limit: LatencyResults['openFileLimit']): number | 'unlimited' {
  const bounds = [limit.soft, limit.maxFilesPerProc]
    .filter((value) => value !== null && value !== 'unlimited')
    .map(Number);
  return bounds.length === 0 ? 'unlimited' : Math.min(...bounds);
}

/** The whole number that command gives option, as --name N or --name=N, or null. */
function commandOption(command: string, name: string): number | null {
  const match = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\d+)(?=\\s|$)`).exec(command);
  return match === null ? null : Number(match[1]);
}

/** The file's text: two-space JSON, with one change per line so that a diff stays readable. */
export function serializeResults(results: LatencyResults): string {
  const { changes, ...rest } = results;
  const head = JSON.stringify(rest, null, 2);
  const lines = changes.map((change) => `    ${JSON.stringify(change)}`);
  return `${head.slice(0, -2)},\n  "changes": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** The results in text, or an error naming the first field that is missing or wrong. */
export function parseResults(text: string): LatencyResults {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('it is not JSON');
  }
  const results = value as LatencyResults;
  const root = record(value, 'the file');
  if (root['format'] !== RESULTS_FORMAT) throw new Error(`format is not ${RESULTS_FORMAT}`);
  for (const key of ['startedAt', 'finishedAt'] as const) {
    const time = str(root, key);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(time) ||
      Number.isNaN(Date.parse(time))
    ) {
      throw new Error(`${key} is not an ISO 8601 time in UTC`);
    }
  }
  str(root, 'command');
  const commit = record(root['commit'], 'commit');
  if (!/^[0-9a-f]{40}$/.test(str(commit, 'sha', 'commit')))
    throw new Error('commit.sha is not a commit');
  bool(commit, 'clean', 'commit');

  const machine = record(root['machine'], 'machine');
  nullableStr(machine, 'name', 'machine');
  nullableStr(machine, 'model', 'machine');
  str(machine, 'cpu', 'machine');
  int(machine, 'cores', 'machine', 1);
  int(machine, 'memoryBytes', 'machine', 1);
  str(machine, 'os', 'machine');
  if (root['colima'] !== null) {
    const colima = record(root['colima'], 'colima');
    str(colima, 'version', 'colima');
    int(colima, 'cpus', 'colima', 1);
    int(colima, 'memoryBytes', 'colima', 1);
    int(colima, 'diskBytes', 'colima', 1);
    str(colima, 'arch', 'colima');
  }
  const versions = record(root['versions'], 'versions');
  for (const key of ['node', 'postgres', 'redis', 'docker']) str(versions, key, 'versions');
  const limit = record(root['openFileLimit'], 'openFileLimit');
  for (const key of ['soft', 'hard', 'maxFilesPerProc']) {
    if (key === 'maxFilesPerProc' && limit[key] === null) continue;
    if (!/^(\d+|unlimited)$/.test(str(limit, key, 'openFileLimit'))) {
      throw new Error(`openFileLimit.${key} is not a number of files or unlimited`);
    }
  }

  const stack = record(root['stack'], 'stack');
  const replicas = record(stack['replicas'], 'stack.replicas');
  for (const key of Object.keys(replicas)) str(replicas, key, 'stack.replicas');
  if (!Object.hasOwn(replicas, str(stack, 'saveTo', 'stack'))) {
    throw new Error('stack.saveTo is not one of stack.replicas');
  }
  int(stack, 'safetyPollMs', 'stack', 1);

  const workload = record(root['workload'], 'workload');
  int(workload, 'tenants', 'workload', 1);
  int(workload, 'flagsPerTenant', 'workload', 1);
  int(workload, 'snapshotBytes', 'workload', 1);
  str(workload, 'flagKey', 'workload');

  const clients = record(root['clients'], 'clients');
  const total = int(clients, 'count', 'clients', 1);
  const byReplica = record(clients['byReplica'], 'clients.byReplica');
  let split = 0;
  for (const key of Object.keys(byReplica)) {
    if (!Object.hasOwn(replicas, key)) throw new Error(`clients.byReplica.${key} is not a replica`);
    split += int(byReplica, key, 'clients.byReplica');
  }
  if (split !== total) throw new Error('clients.byReplica does not add up to clients.count');
  str(clients, 'ranIn', 'clients');

  const phases = record(root['phases'], 'phases');
  const changes = root['changes'];
  if (!Array.isArray(changes)) throw new Error('changes is not an array');
  for (const [index, entry] of changes.entries()) {
    const change = record(entry, `changes[${index}]`);
    if (!(PHASES as readonly unknown[]).includes(change['phase'])) {
      throw new Error(`changes[${index}].phase is not warmup or measured`);
    }
    int(change, 'version', `changes[${index}]`, 1);
    duration(change, 'saveMs', `changes[${index}]`);
    duration(change, 'lastClientMs', `changes[${index}]`);
  }
  for (const phase of PHASES) {
    const totals = record(phases[phase], `phases.${phase}`);
    const expected = int(totals, 'changes', `phases.${phase}`);
    int(totals, 'reconnects', `phases.${phase}`);
    int(totals, 'clientErrors', `phases.${phase}`);
    const other = record(totals['otherDeliveries'], `phases.${phase}.otherDeliveries`);
    for (const cause of OTHER_CAUSES) int(other, cause, `phases.${phase}.otherDeliveries`);
    const listed = changes.filter((change) => (change as Change).phase === phase).length;
    if (listed !== expected) {
      throw new Error(`phases.${phase}.changes is ${expected}, but changes lists ${listed}`);
    }
  }
  if (results.phases.measured.changes < 1) throw new Error('the run has no measured change');
  // The counts must be the ones the command asked for, so that a run whose changes
  // were labelled with the wrong phase, or that lost clients, cannot pass as valid.
  const asked: [string, number][] = [
    ['clients', total],
    ['warmup', results.phases.warmup.changes],
    ['changes', results.phases.measured.changes],
  ];
  for (const [option, count] of asked) {
    const given = commandOption(results.command, option);
    if (given !== count) {
      throw new Error(
        `command gives --${option} ${given ?? '(nothing)'}, but the run has ${count}`,
      );
    }
  }
  const order = (changes as Change[]).map((change) => change.phase);
  if (order.lastIndexOf('warmup') > order.indexOf('measured')) {
    throw new Error('a warm-up change comes after a measured one');
  }
  return results;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function where(key: string, parent?: string): string {
  return parent === undefined ? key : `${parent}.${key}`;
}

function str(object: Record<string, unknown>, key: string, parent?: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '')
    throw new Error(`${where(key, parent)} is not a text`);
  return value;
}

function nullableStr(object: Record<string, unknown>, key: string, parent: string): void {
  if (object[key] !== null) str(object, key, parent);
}

function bool(object: Record<string, unknown>, key: string, parent: string): void {
  if (typeof object[key] !== 'boolean')
    throw new Error(`${where(key, parent)} is not true or false`);
}

function int(object: Record<string, unknown>, key: string, parent: string, min = 0): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${where(key, parent)} is not a whole number of at least ${min}`);
  }
  return value;
}

function duration(object: Record<string, unknown>, key: string, parent: string): void {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where(key, parent)} is not a duration in ms`);
  }
}
