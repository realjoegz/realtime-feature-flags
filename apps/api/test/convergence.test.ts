import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Flag, Rule } from '@rff/core';
import { FlagsClient, type FlagsSnapshot, ReadTimeoutError } from '@rff/sdk';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config } from '../src/config.js';
import { TenantDatabase } from '../src/database/tenant-database.js';
import { readSnapshot, readVersion } from '../src/flags/flag-store.js';
import { SnapshotReader, type TenantRead } from '../src/stream/snapshot-reader.js';
import { StreamHub } from '../src/stream/stream-hub.js';
import { CONFIG } from '../src/tokens.js';
import { type AppChanges, type Call, type Environment, startEnvironment } from './support/api.js';
import { runParams } from './support/fc-params.js';
import { type DropMode, FaultyNetwork } from './support/network.js';
import { databaseSnapshot, eventually } from './support/snapshots.js';

// Convergence on one instance. Each run is a new tenant with three SDK clients that
// connect over fetch to a real Nest app on a real Postgres, each through its own
// FaultyNetwork. fast-check draws a sequence of steps: a save through the API, two
// to five saves at once, dropping one client's connection (cut or stalled), and
// reconnecting it. After the last step every network comes back, and the run checks:
//
//   - the successful writes have versions 1 to n with no gap, and the tenant ends at n;
//   - before a deadline, every client holds the database's version and flags;
//   - the versions each client applied strictly increase;
//   - every snapshot a client applied holds the flags of its version, as the writes
//     in version order give them.
//
// Then, with every network up and every client up to date, the run saves 3 or 4
// different flags at once and checks the same again, three times. A client whose
// connection is open gets these versions only through the fan-out's wake-ups, so a
// wake-up that arrives while the fan-out reads must lead to one more read.
//
// The deadline only keeps a run that does not converge from waiting forever; the
// test makes no claim about how fast clients converge. The controls run the same
// property against an app that does not read on connect and an app that reads the
// version and the flags apart, and pass only when it fails for the expected reason.

const CLIENTS = 3;
const MAX_STEPS = 20;
const HEARTBEAT_MS = 100;
const DEADLINE_MS = 5000;
const SPLIT_DELAY_MS = 25;
const SIMULATION = runParams(20);
const KEYS = ['alpha', 'beta', 'gamma', 'delta'] as const;

const SIMULATION_LABEL = `(seed ${SIMULATION.seed}, ${SIMULATION.numRuns} runs of up to ${MAX_STEPS} steps)`;

interface SaveOp {
  readonly key: string;
  /** Delete the flag when it exists; otherwise update it, or create it when it does not. */
  readonly remove: boolean;
  readonly enabled: boolean;
  readonly rules: Rule[];
  readonly rolloutBasisPoints: number;
}

/** A successful write as the test sent it; a create carries the salt the server chose. */
type Write =
  | { readonly kind: 'create'; readonly flag: Flag }
  | { readonly kind: 'update'; readonly key: string; readonly op: SaveOp }
  | { readonly kind: 'delete'; readonly key: string };

interface SimClient {
  readonly network: FaultyNetwork;
  readonly client: FlagsClient;
  readonly applied: FlagsSnapshot[];
}

/** What the runs of one property did, to show that they exercised each step and fault. */
interface Tally {
  runs: number;
  saves: number;
  concurrentSaves: number;
  /** Saves refused with 404 or 409 because a concurrent save of the key won. */
  conflicts: number;
  cuts: number;
  stalls: number;
  reconnects: number;
  /** Stalled connections that a client's read timeout gave up on. */
  readTimeouts: number;
  /** Connections that clients opened after their first one. */
  reopened: number;
}

const newTally = (): Tally => ({
  runs: 0,
  saves: 0,
  concurrentSaves: 0,
  conflicts: 0,
  cuts: 0,
  stalls: 0,
  reconnects: 0,
  readTimeouts: 0,
  reopened: 0,
});

const byKey = (flags: Iterable<Flag>): Flag[] =>
  [...flags].toSorted((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

class Run {
  /** Successful writes by the version the API answered with. */
  readonly writes = new Map<number, Write>();

  private constructor(
    private readonly env: Environment,
    readonly tenantId: string,
    readonly clients: readonly SimClient[],
    readonly tally: Tally,
  ) {}

  static async start(env: Environment, tally: Tally): Promise<Run> {
    tally.runs += 1;
    const tenantId = randomUUID();
    const sdkKey = `rff_sdk_${randomBytes(32).toString('base64url')}`;
    await env.admin.query(
      `INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'Simulation')`,
      [tenantId, `sim-${tenantId}`],
    );
    await env.admin.query(
      `INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [tenantId, env.world.people.editorOfA.id],
    );
    await env.admin.query('INSERT INTO public.sdk_keys (tenant_id, key_hash) VALUES ($1, $2)', [
      tenantId,
      createHash('sha256').update(sdkKey).digest(),
    ]);
    const clients = Array.from({ length: CLIENTS }, (): SimClient => {
      const network = new FaultyNetwork();
      const client = new FlagsClient({
        url: env.api.base,
        sdkKey,
        fetch: network.fetch,
        heartbeatIntervalMs: HEARTBEAT_MS,
        reconnect: { initialMs: 10, maxMs: 100 },
        onError: (error) => {
          if (error instanceof ReadTimeoutError) tally.readTimeouts += 1;
        },
      });
      const applied: FlagsSnapshot[] = [];
      client.onChange((snapshot) => applied.push(snapshot));
      return { network, client, applied };
    });
    return new Run(env, tenantId, clients, tally);
  }

  /** The flags at version, from the writes up to it in version order. */
  stateAt(version: number): Flag[] {
    const flags = new Map<string, Flag>();
    for (const [at, write] of [...this.writes].toSorted(([x], [y]) => x - y)) {
      if (at > version) break;
      if (write.kind === 'create') flags.set(write.flag.key, write.flag);
      else if (write.kind === 'delete') flags.delete(write.key);
      else {
        const before = flags.get(write.key);
        if (before === undefined)
          throw new Error(`version ${at} updates ${write.key}, which is not there`);
        const { enabled, rules, rolloutBasisPoints } = write.op;
        flags.set(write.key, {
          key: write.key,
          enabled,
          salt: before.salt,
          rules,
          rolloutBasisPoints,
        });
      }
    }
    return byKey(flags.values());
  }

  /** Sends every op at once. Each decides between POST, PUT and DELETE from the flags before the step. */
  async save(ops: readonly SaveOp[]): Promise<void> {
    const latest = Math.max(0, ...this.writes.keys());
    const existing = new Set(this.stateAt(latest).map((flag) => flag.key));
    const path = `/tenants/${this.tenantId}/flags`;
    await Promise.all(
      ops.map(async (op) => {
        const settings = {
          enabled: op.enabled,
          rules: op.rules,
          rolloutBasisPoints: op.rolloutBasisPoints,
        };
        const call: Call = !existing.has(op.key)
          ? { method: 'POST', path, body: { key: op.key, ...settings } }
          : op.remove
            ? { method: 'DELETE', path: `${path}/${op.key}` }
            : { method: 'PUT', path: `${path}/${op.key}`, body: settings };
        const reply = await this.env.send(this.env.world.people.editorOfA, call);
        // Two saves of one key at once: the loser finds it created or deleted.
        if (reply.status === 404 || reply.status === 409) {
          this.tally.conflicts += 1;
          return;
        }
        if (reply.status !== 200 && reply.status !== 201) {
          throw new Error(`${call.method} ${op.key} answered ${reply.status}: ${reply.text}`);
        }
        const body = reply.body as { version: number; flag?: Flag };
        const write: Write =
          call.method === 'POST'
            ? { kind: 'create', flag: { key: op.key, salt: body.flag?.salt ?? '', ...settings } }
            : call.method === 'DELETE'
              ? { kind: 'delete', key: op.key }
              : { kind: 'update', key: op.key, op };
        if (this.writes.has(body.version)) {
          throw new Error(`two writes answered with version ${body.version}`);
        }
        this.writes.set(body.version, write);
      }),
    );
  }

  /**
   * Ends the faults and checks the invariants; then, for each round, saves its ops
   * at once, with every client up to date, and checks them again. Throws on the
   * first that fails.
   */
  async settle(rounds: readonly (readonly SaveOp[])[]): Promise<void> {
    for (const { network } of this.clients) network.up();
    await this.check();
    for (const ops of rounds) {
      // eslint-disable-next-line no-await-in-loop -- each round starts from converged clients
      await this.save(ops);
      // eslint-disable-next-line no-await-in-loop -- each round starts from converged clients
      await this.check();
    }
  }

  private async check(): Promise<void> {
    const database = await databaseSnapshot(this.env.admin, this.tenantId);
    const versions = [...this.writes.keys()].toSorted((x, y) => x - y);
    if (
      !isDeepStrictEqual(
        versions,
        versions.map((_, index) => index + 1),
      )
    ) {
      throw new Error(`the write versions have a gap: ${versions.join(', ')}`);
    }
    if (database.version !== versions.length) {
      throw new Error(
        `the tenant is at version ${database.version} after ${versions.length} writes`,
      );
    }
    if (!isDeepStrictEqual(this.stateAt(database.version), database.flags)) {
      throw new Error('the writes in version order do not give the database flags');
    }

    const converged = (): boolean =>
      this.clients.every(
        ({ client }) =>
          client.version === database.version && isDeepStrictEqual(client.flags, database.flags),
      );
    try {
      await eventually(converged, 'convergence', DEADLINE_MS);
    } catch {
      const held = this.clients.map(({ client }) => client.version).join(', ');
      throw new Error(
        `did not converge within ${DEADLINE_MS} ms: the clients hold versions ${held}, the database ${database.version}`,
      );
    }

    this.clients.forEach(({ applied }, index) => {
      const order = applied.map((snapshot) => snapshot.version);
      if (order.some((version, at) => at > 0 && version <= (order[at - 1] as number))) {
        throw new Error(`client ${index} applied versions out of order: ${order.join(', ')}`);
      }
      for (const snapshot of applied) {
        if (snapshot.tenantId !== this.tenantId) {
          throw new Error(`client ${index} applied a snapshot of tenant ${snapshot.tenantId}`);
        }
        if (!isDeepStrictEqual([...snapshot.flags], this.stateAt(snapshot.version))) {
          throw new Error(
            `client ${index} applied a snapshot of version ${snapshot.version} whose flags are not the flags of that version`,
          );
        }
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map(({ client }) => client.close()));
    for (const { network } of this.clients) this.tally.reopened += Math.max(0, network.opened - 1);
  }
}

interface Model {
  readonly down: Set<number>;
}

type Step = fc.AsyncCommand<Model, Run>;

const describeOp = (op: SaveOp): string =>
  `${op.key}${op.remove ? ' remove' : ''} ${op.enabled ? 'on' : 'off'} ${op.rolloutBasisPoints} rules ${op.rules.length}`;

class Save implements Step {
  constructor(readonly ops: readonly SaveOp[]) {}
  check(): boolean {
    return true;
  }
  async run(_model: Model, run: Run): Promise<void> {
    if (this.ops.length === 1) run.tally.saves += 1;
    else run.tally.concurrentSaves += 1;
    await run.save(this.ops);
  }
  toString(): string {
    return this.ops.length === 1
      ? `save(${describeOp(this.ops[0] as SaveOp)})`
      : `concurrent saves(${this.ops.map(describeOp).join('; ')})`;
  }
}

class Drop implements Step {
  constructor(
    readonly client: number,
    readonly mode: DropMode,
  ) {}
  check(model: Readonly<Model>): boolean {
    return !model.down.has(this.client);
  }
  async run(model: Model, run: Run): Promise<void> {
    model.down.add(this.client);
    if (this.mode === 'cut') run.tally.cuts += 1;
    else run.tally.stalls += 1;
    run.clients[this.client]?.network.drop(this.mode);
  }
  toString(): string {
    return `drop(client ${this.client}, ${this.mode})`;
  }
}

class Reconnect implements Step {
  constructor(readonly client: number) {}
  check(model: Readonly<Model>): boolean {
    return model.down.has(this.client);
  }
  async run(model: Model, run: Run): Promise<void> {
    model.down.delete(this.client);
    run.tally.reconnects += 1;
    run.clients[this.client]?.network.up();
  }
  toString(): string {
    return `reconnect(client ${this.client})`;
  }
}

const VALUES = ['pro', 'free', 'NL', 'US'] as const;

const rule: fc.Arbitrary<Rule> = fc.oneof(
  fc.record(
    {
      attribute: fc.constantFrom('plan', 'country'),
      operator: fc.constant('equals' as const),
      values: fc.constantFrom(...VALUES).map((value) => [value]),
      serve: fc.boolean(),
    },
    { noNullPrototype: true },
  ),
  fc.record(
    {
      attribute: fc.constantFrom('plan', 'country'),
      operator: fc.constant('in' as const),
      values: fc.uniqueArray(fc.constantFrom(...VALUES), { minLength: 1, maxLength: 3 }),
      serve: fc.boolean(),
    },
    { noNullPrototype: true },
  ),
);

const saveOp: fc.Arbitrary<SaveOp> = fc.record(
  {
    key: fc.constantFrom(...KEYS),
    remove: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
    enabled: fc.boolean(),
    rules: fc.array(rule, { maxLength: 2 }),
    rolloutBasisPoints: fc.integer({ min: 0, max: 10_000 }),
  },
  { noNullPrototype: true },
);

const steps = fc.commands<Model, Run, false>(
  [
    saveOp.map((op): Step => new Save([op])),
    fc.array(saveOp, { minLength: 2, maxLength: 5 }).map((ops): Step => new Save(ops)),
    fc
      .record(
        { client: fc.nat(CLIENTS - 1), mode: fc.constantFrom<DropMode>('cut', 'stall') },
        { noNullPrototype: true },
      )
      .map(({ client, mode }): Step => new Drop(client, mode)),
    fc.nat(CLIENTS - 1).map((client): Step => new Reconnect(client)),
  ],
  { maxCommands: MAX_STEPS, size: 'max' },
);

/** Three rounds of saves of 3 or 4 different flags, which all succeed when sent at once. */
const finalRounds = fc.array(
  fc.uniqueArray(saveOp, { minLength: 3, maxLength: KEYS.length, selector: (op) => op.key }),
  { minLength: 3, maxLength: 3 },
);

function convergence(env: Environment, tally: Tally = newTally()) {
  return fc.asyncProperty(steps, finalRounds, async (commands, rounds) => {
    const run = await Run.start(env, tally);
    try {
      await fc.asyncModelRun(() => ({ model: { down: new Set<number>() }, real: run }), commands);
      await run.settle(rounds);
    } finally {
      await run.close();
    }
  });
}

const configure = (config: Config): Config => ({
  ...config,
  stream: { heartbeatMs: HEARTBEAT_MS },
});

const PARAMS = { seed: SIMULATION.seed, numRuns: SIMULATION.numRuns, endOnFailure: true };

/** The message of the error that made a control's property fail. */
async function failureOf(changes: AppChanges, label: string): Promise<string> {
  const subject = await startEnvironment(label, { configure, ...changes });
  try {
    const details = await fc.check(convergence(subject), PARAMS);
    if (!details.failed) return 'the property held';
    const error = details.errorInstance;
    return error instanceof Error ? error.message : String(error);
  } finally {
    await subject.close();
  }
}

let env: Environment;

beforeAll(async () => {
  env = await startEnvironment('convergence', { configure });
});

afterAll(async () => {
  await env?.close();
});

describe('convergence on one instance', () => {
  it(
    `${CLIENTS} SDK clients end with the database's flags and version once faults stop and again after each of 3 rounds of saves made at once while every client is connected, apply strictly increasing versions whose snapshots each hold the flags of their version, and the tenant's versions have no gaps under concurrent saves ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const tally = newTally();
      await fc.assert(convergence(env, tally), PARAMS);
      // The runs together took every kind of step and met every fault: saves that
      // lost to a concurrent save, stalls that only a read timeout ended, and
      // clients that reconnected and caught up.
      const floor = Math.ceil(SIMULATION.numRuns / 4);
      const { runs, ...counts } = tally;
      expect(runs).toBe(SIMULATION.numRuns);
      for (const [name, count] of Object.entries(counts)) {
        expect(count, `${name} in ${JSON.stringify(tally)}`).toBeGreaterThanOrEqual(floor);
      }
    },
  );

  it(
    `control: with no read when a stream opens, a client that missed changes while it was disconnected does not converge ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf(
        {
          override: (builder) =>
            builder.overrideProvider(StreamHub).useFactory({
              factory: (config: Config, reader: SnapshotReader) => new NoReplayHub(config, reader),
              inject: [CONFIG, SnapshotReader],
            }),
        },
        'convnoreplay',
      );
      expect(message).toMatch(/^did not converge within 5000 ms/);
    },
  );

  it(
    `control: a read that takes the version and the flags ${SPLIT_DELAY_MS} ms apart fails the check that each applied snapshot holds the flags of its version ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf(
        {
          override: (builder) =>
            builder.overrideProvider(SnapshotReader).useFactory({
              factory: (db: TenantDatabase) => new SplitSnapshotReader(db),
              inject: [TenantDatabase],
            }),
        },
        'convsplit',
      );
      expect(message).toMatch(
        /applied a snapshot of version \d+ whose flags are not the flags of that version$/,
      );
    },
  );
});

/** A broken fan-out: a stream that opens is not read for, so it waits for the next change. */
class NoReplayHub extends StreamHub {
  protected override connected(): void {}
}

/** A broken read: the version in one transaction, the flags in another, 25 ms later. */
class SplitSnapshotReader extends SnapshotReader {
  override async read(tenantId: string, above: number): Promise<TenantRead | null> {
    const scope = { tenantId, userId: null };
    const version = await this.db.withTenant(scope, (client) => readVersion(client, tenantId));
    if (version === null) return null;
    if (version <= above) return { version, snapshot: null };
    await new Promise((resolve) => setTimeout(resolve, SPLIT_DELAY_MS));
    const later = await this.db.withTenant(scope, (client) => readSnapshot(client, tenantId));
    return later === null ? null : { version, snapshot: { tenantId, version, flags: later.flags } };
  }
}
