import type { Change, LatencyResults, Phase } from '../../src/results.ts';

/** [time to the last client, save round trip] of one change, in ms. */
export type Times = readonly [number, number];

export interface Example {
  readonly startedAt: string;
  readonly warmup?: readonly Times[];
  readonly measured: readonly Times[];
  readonly sha?: string;
}

/** The results of a run on the machine that the measured runs use, with the given times. */
export function exampleResults(example: Example): LatencyResults {
  const warmup = example.warmup ?? [];
  let version = 10;
  const changes = (phase: Phase, times: readonly Times[]): Change[] =>
    times.map(([lastClientMs, saveMs]) => {
      version += 1;
      return { phase, version, saveMs, lastClientMs };
    });
  const quiet = {
    reconnects: 0,
    clientErrors: 0,
    otherDeliveries: { connect: 0, ready: 0, poll: 0 },
  };
  return {
    format: 1,
    startedAt: example.startedAt,
    finishedAt: example.startedAt.replace(/:\d{2}\.\d{3}Z$/, ':59.000Z'),
    command: `npm run latency -- --clients 50 --warmup ${warmup.length} --changes ${example.measured.length}`,
    commit: { sha: example.sha ?? '0123456789abcdef0123456789abcdef01234567', clean: true },
    machine: {
      name: 'MacBook Air',
      model: 'Mac16,12',
      cpu: 'Apple M4',
      cores: 10,
      memoryBytes: 16 * 2 ** 30,
      os: 'macOS 26.6.2',
    },
    colima: {
      version: '0.10.3',
      cpus: 6,
      memoryBytes: 8 * 2 ** 30,
      diskBytes: 60 * 2 ** 30,
      arch: 'aarch64',
    },
    versions: { node: '24.13.0', postgres: '18.6', redis: '8.10.2', docker: '29.5.2' },
    openFileLimit: { soft: '1048575', hard: 'unlimited', maxFilesPerProc: '61440' },
    stack: {
      replicas: { 'api-1': 'http://127.0.0.1:4001', 'api-2': 'http://127.0.0.1:4002' },
      saveTo: 'api-1',
      safetyPollMs: 30_000,
    },
    workload: { tenants: 1, flagsPerTenant: 3, snapshotBytes: 531, flagKey: 'dark-mode' },
    clients: {
      count: 50,
      byReplica: { 'api-1': 25, 'api-2': 25 },
      ranIn:
        "the Node process on the host that sends the saves, each connected directly to its replica's published port",
    },
    phases: {
      warmup: { changes: warmup.length, ...quiet },
      measured: { changes: example.measured.length, ...quiet },
    },
    changes: [...changes('warmup', warmup), ...changes('measured', example.measured)],
  };
}
