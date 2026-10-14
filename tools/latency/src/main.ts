// Times flag saves on the compose stack to the last of C SDK clients.
//
//   docker compose up --build --detach --wait
//   npm run build
//   npm run latency -- --clients C --warmup W --changes M [--out DIR]
//
// The tool signs alice, acme's owner, in through Dex with the curl code flow of
// scripts/lib/dex-sign-in.sh, opens C FlagsClients (@rff/sdk) with acme's seeded SDK
// key, alternately on api-1 and api-2, connected directly to their published ports,
// and waits until every client holds acme's current version. Then, one change at a
// time, it saves W warm-up and M measured changes of one flag's rollout with a PUT
// to api-1. For each change, on the one clock of performance.now(): t0 just before
// the PUT is sent, the PUT's round trip to the end of its response, and the time
// from t0 to the last client's onChange for the saved version or a later one. The
// next change starts once every client holds the saved one (run.ts).
//
// Before and after each phase it counts, in the replicas' logs, the snapshots sent
// after a wake-up other than a Redis notification (deliveries.ts), and the clients'
// reconnects and reported errors. It checks that every client ends on the
// database's flags, puts the flag back as it was, and writes the raw times and the
// conditions of the run to DIR/latency-<UTC start>.json (default bench/results).
// npm run latency:render renders the README table from those files.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { FlagsClient, parseSnapshot, type SseEvent, SseParser } from '@rff/sdk';
import { Arrivals } from './arrivals.ts';
import { otherDeliveries, totalDeliveries } from './deliveries.ts';
import { RESULTS_DIRECTORY } from './readme-table.ts';
import {
  type LatencyResults,
  type OtherDeliveries,
  openFiles,
  parseResults,
  RESULTS_FORMAT,
  resultsFileName,
  serializeResults,
} from './results.ts';
import {
  checkConnectsLogged,
  clientsByReplica,
  type Mark,
  phaseTotals,
  reconnects,
  replicaOf,
  runChanges,
} from './run.ts';
import { accessToken } from './sign-in.ts';
import {
  colima,
  commit,
  composeLogs,
  machine,
  openFileLimit,
  safetyPollMs,
  stackVersions,
} from './stack.ts';
import { summarize, type Summary } from './stats.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Local demo values (dex/local-demo-config.yaml, apps/api/src/seed/demo-data.ts):
// alice owns acme, and this is acme's seeded SDK key.
const LOGIN = 'alice@example.test';
const PASSWORD = 'alice-local-pass';
const TENANT_SLUG = 'acme';
const SDK_KEY = 'rff_sdk_acme-local-demo-key-not-a-secret00000000000';
const FLAG_KEY = 'dark-mode';

/** File descriptors the process needs besides one socket per client. */
const SPARE_FILES = 64;
const CONNECT_DEADLINE_MS = 30_000;
/** A change that takes longer than a safety poll interval plus this fails the run. */
const DELIVERY_MARGIN_MS = 10_000;
/** The wait before reading the logs, so that lines written just before reach them. */
const LOG_SETTLE_MS = 1000;
const RAN_IN =
  "the Node process on the host that sends the saves, each connected directly to its replica's published port";

interface Options {
  readonly clients: number;
  readonly warmup: number;
  readonly changes: number;
  readonly out: string;
  readonly replicaUrls: readonly [string, string];
}

const USAGE =
  'usage: npm run latency -- --clients C --warmup W --changes M [--out DIR] [--api-1 URL] [--api-2 URL]';

function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      clients: { type: 'string' },
      warmup: { type: 'string' },
      changes: { type: 'string' },
      out: { type: 'string' },
      'api-1': { type: 'string', default: 'http://127.0.0.1:4001' },
      'api-2': { type: 'string', default: 'http://127.0.0.1:4002' },
    },
  });
  const whole = (name: 'clients' | 'warmup' | 'changes', min: number): number => {
    const value = Number(values[name]);
    if (values[name] === undefined || !Number.isSafeInteger(value) || value < min) {
      throw new Error(`--${name} needs a whole number of at least ${min}. ${USAGE}`);
    }
    return value;
  };
  return {
    clients: whole('clients', 2),
    warmup: whole('warmup', 0),
    changes: whole('changes', 1),
    out: path.resolve(values.out ?? path.join(ROOT, RESULTS_DIRECTORY)),
    replicaUrls: [values['api-1'].replace(/\/+$/, ''), values['api-2'].replace(/\/+$/, '')],
  };
}

function commandLine(): string {
  const args = process.argv
    .slice(2)
    .map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(' ');
  if (process.env['npm_lifecycle_event'] === 'latency') return `npm run latency -- ${args}`;
  return `node ${path.relative(ROOT, process.argv[1] ?? '')} ${args}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

async function request(method: string, url: string, token: string, body?: unknown): Promise<Reply> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

function expectOk(reply: Reply, what: string): Record<string, unknown> {
  if (reply.status !== 200 || typeof reply.body !== 'object' || reply.body === null) {
    throw new Error(`${what}: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  return reply.body as Record<string, unknown>;
}

async function instanceOf(url: string): Promise<string> {
  const response = await fetch(`${url}/health`);
  const body = (await response.json()) as { instance?: unknown };
  if (response.status !== 200 || typeof body.instance !== 'string') {
    throw new Error(`GET ${url}/health: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.instance;
}

/** The data of the first snapshot event on a new stream, as the replica sends it. */
async function firstSnapshot(url: string): Promise<SseEvent> {
  const controller = new AbortController();
  const response = await fetch(`${url}/sdk/stream`, {
    headers: { accept: 'text/event-stream', authorization: `Bearer ${SDK_KEY}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`GET ${url}/sdk/stream: ${response.status}`);
  }
  const snapshots: SseEvent[] = [];
  const parser = new SseParser((event) => {
    if (event.type === 'snapshot') snapshots.push(event);
  });
  const reader = response.body.getReader();
  try {
    for (;;) {
      const [first] = snapshots;
      if (first !== undefined) return first;
      // eslint-disable-next-line no-await-in-loop -- chunks arrive one after another
      const { done, value } = await reader.read();
      if (done) throw new Error(`the stream on ${url} ended before a snapshot`);
      parser.push(value);
    }
  } finally {
    controller.abort();
  }
}

const ms = (value: number) => value.toFixed(1);

function summaryLine(name: string, summary: Summary): string {
  return `${name}: min ${ms(summary.min)}, median ${ms(summary.median)}, p95 ${ms(summary.p95)}, max ${ms(summary.max)} ms over ${summary.count} changes`;
}

interface Counter {
  connects: number;
  errors: number;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const command = commandLine();

  const limit = await openFileLimit();
  const fileLimit = openFiles(limit);
  if (fileLimit !== 'unlimited' && options.clients + SPARE_FILES > fileLimit) {
    throw new Error(
      `${options.clients} clients need ${options.clients} sockets and about ${SPARE_FILES} other files, and this process can open ${fileLimit} files (ulimit -n ${limit.soft}, kern.maxfilesperproc ${limit.maxFilesPerProc ?? 'none'})`,
    );
  }
  const [saveUrl, otherUrl] = options.replicaUrls;
  const names = [await instanceOf(saveUrl), await instanceOf(otherUrl)] as const;
  if (names[0] === names[1]) throw new Error(`${saveUrl} and ${otherUrl} are both ${names[0]}`);
  const [saveTo] = names;

  console.log('latency: reading the conditions of the run');
  const [commitInfo, machineInfo, colimaInfo, versions, polls] = await Promise.all([
    commit(ROOT),
    machine(),
    colima(),
    stackVersions(ROOT),
    Promise.all(names.map((name) => safetyPollMs(ROOT, name))),
  ]);
  const [pollMs] = polls;
  if (pollMs === undefined || polls[1] !== pollMs) {
    throw new Error(`the replicas poll every ${polls.join(' and ')} ms`);
  }
  if (!commitInfo.clean)
    console.log('latency: the work tree has uncommitted changes; the results say so');

  console.log(`latency: signing ${LOGIN} in through Dex`);
  const token = await accessToken(ROOT, LOGIN, PASSWORD);
  const me = expectOk(await request('GET', `${saveUrl}/me`, token), `GET ${saveUrl}/me`);
  const memberships = (me['memberships'] ?? []) as {
    slug: string;
    role: string;
    tenantId: string;
  }[];
  const tenantId = memberships.find((m) => m.slug === TENANT_SLUG && m.role === 'owner')?.tenantId;
  if (tenantId === undefined) throw new Error(`${LOGIN} is not the owner of ${TENANT_SLUG}`);
  const flagsUrl = `${saveUrl}/tenants/${tenantId}/flags`;
  const flagUrl = `${flagsUrl}/${FLAG_KEY}`;
  const original = expectOk(await request('GET', flagUrl, token), `GET ${flagUrl}`);

  const logs = async (): Promise<OtherDeliveries> => {
    await sleep(LOG_SETTLE_MS);
    return otherDeliveries(await composeLogs(ROOT, names), tenantId);
  };
  const beforeConnect = await logs();

  const total = options.clients;
  const arrivals = new Arrivals(total);
  const counters: Counter[] = Array.from({ length: total }, () => ({ connects: 0, errors: 0 }));
  const errors: string[] = [];
  const byReplica = clientsByReplica(total, names);
  const clients = counters.map((counter, index) => {
    const client = new FlagsClient({
      url: options.replicaUrls[replicaOf(index)],
      sdkKey: SDK_KEY,
      fetch: (input, init) => {
        counter.connects += 1;
        return fetch(input, init);
      },
      onError: (error) => {
        counter.errors += 1;
        if (errors.length < 10) errors.push(`client ${index}: ${error.message}`);
      },
    });
    client.onChange((snapshot) => arrivals.record(index, snapshot.version, performance.now()));
    return client;
  });
  const mark = async (): Promise<Mark> => ({
    deliveries: await logs(),
    reconnects: reconnects(counters.map((counter) => counter.connects)),
    errors: counters.reduce((sum, counter) => sum + counter.errors, 0),
  });

  let changed = false;
  let results: LatencyResults;
  try {
    console.log(
      `latency: connecting ${total} clients, ${byReplica[names[0]]} to ${names[0]} and ${byReplica[names[1]]} to ${names[1]}`,
    );
    const current = expectOk(await request('GET', flagsUrl, token), `GET ${flagsUrl}`);
    await arrivals.whenAllAt(current['version'] as number, CONNECT_DEADLINE_MS);
    const connected = await mark();
    checkConnectsLogged(beforeConnect, connected.deliveries, total);

    changed = true;
    const { changes, warmedUp, finished } = await runChanges({
      warmup: options.warmup,
      changes: options.changes,
      url: flagUrl,
      token,
      fetch,
      now: () => performance.now(),
      arrivals,
      deadlineMs: pollMs + DELIVERY_MARGIN_MS,
      // Four digits every time, so the snapshot keeps its size, and never the same twice in a row.
      body: (index) =>
        JSON.stringify({
          enabled: original['enabled'],
          rules: original['rules'],
          rolloutBasisPoints: 1000 + (index % 9000),
        }),
      mark,
      progress: (done, steps) => {
        if (done === options.warmup && done < steps) {
          console.log(
            `latency: ${options.warmup} warm-up changes done, measuring ${options.changes}`,
          );
        } else if (done % 50 === 0) console.log(`latency: ${done} of ${steps} changes`);
      },
    });

    const final = expectOk(await request('GET', flagsUrl, token), `GET ${flagsUrl}`);
    const behind = clients.flatMap((client, index) =>
      client.version === final['version'] && isDeepStrictEqual(client.flags, final['flags'])
        ? []
        : [index],
    );
    if (behind.length > 0) {
      throw new Error(
        `clients ${behind.join(', ')} do not hold the database's flags at version ${String(final['version'])}`,
      );
    }
    const snapshot = await firstSnapshot(saveUrl);
    const parsed = parseSnapshot(snapshot.data);

    results = {
      format: RESULTS_FORMAT,
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
      commit: commitInfo,
      machine: machineInfo,
      colima: colimaInfo,
      versions,
      openFileLimit: limit,
      stack: {
        replicas: { [names[0]]: saveUrl, [names[1]]: otherUrl },
        saveTo,
        safetyPollMs: pollMs,
      },
      workload: {
        tenants: 1,
        flagsPerTenant: parsed.flags.length,
        snapshotBytes: Buffer.byteLength(snapshot.data, 'utf8'),
        flagKey: FLAG_KEY,
      },
      clients: { count: total, byReplica, ranIn: RAN_IN },
      phases: {
        warmup: phaseTotals(changes, 'warmup', connected, warmedUp),
        measured: phaseTotals(changes, 'measured', warmedUp, finished),
      },
      changes: [...changes],
    };
  } finally {
    if (changed) {
      const restore = {
        enabled: original['enabled'],
        rules: original['rules'],
        rolloutBasisPoints: original['rolloutBasisPoints'],
      };
      const reply = await request('PUT', flagUrl, token, restore).catch((error: unknown) => ({
        status: 0,
        body: (error as Error).message,
      }));
      if (reply.status !== 200)
        console.error(`latency: putting ${FLAG_KEY} back failed: ${JSON.stringify(reply.body)}`);
    }
    await Promise.all(clients.map((client) => client.close()));
    if (errors.length > 0) console.error(`latency: client errors:\n  ${errors.join('\n  ')}`);
  }

  const text = serializeResults(results);
  parseResults(text);
  await mkdir(options.out, { recursive: true });
  const file = path.join(options.out, resultsFileName(startedAt));
  await writeFile(file, text, { flag: 'wx' });
  const measured = results.changes.filter((change) => change.phase === 'measured');
  console.log(summaryLine('to the last client', summarize(measured.map((c) => c.lastClientMs))));
  console.log(summaryLine('save round trip', summarize(measured.map((c) => c.saveMs))));
  const { clientErrors, otherDeliveries: other } = results.phases.measured;
  console.log(
    `latency: measured phase: ${results.phases.measured.reconnects} reconnects, ${clientErrors} client errors, ${totalDeliveries(other)} deliveries not by notification (connect ${other.connect}, ready ${other.ready}, poll ${other.poll})`,
  );
  const shown = path.relative(process.cwd(), file);
  console.log(`latency: wrote ${shown.startsWith('..') ? file : shown}`);
}

try {
  await main();
} catch (error) {
  console.error(`latency: ${(error as Error).message}`);
  process.exitCode = 1;
}
