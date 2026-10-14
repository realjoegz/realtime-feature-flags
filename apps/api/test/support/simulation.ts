import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Flag, Rule } from '@rff/core';
import { FlagsClient, type FlagsSnapshot, ReadTimeoutError } from '@rff/sdk';
import fc from 'fast-check';
import { type Config } from '../../src/config.js';
import { TenantDatabase } from '../../src/database/tenant-database.js';
import { readSnapshot, readVersion } from '../../src/flags/flag-store.js';
import { FlagsCache } from '../../src/flags/flags-cache.js';
import { SnapshotReader, type TenantRead } from '../../src/stream/snapshot-reader.js';
import { type Deliveries, StreamHub } from '../../src/stream/stream-hub.js';
import { CONFIG } from '../../src/tokens.js';
import { type AppChanges, type Call, type Environment, startEnvironment } from './api.js';
import { BusFaults, killConnection, subscriberName, withFaultyBus } from './bus-faults.js';
import { runParams } from './fc-params.js';
import { type DropMode, FaultyNetwork } from './network.js';
import { databaseSnapshot, eventually } from './snapshots.js';

// The convergence simulation on two Nest apps in one process, on separate ports,
// sharing Postgres and Redis as two replicas do. Each run is a new tenant with four
// SDK clients that connect over fetch, two to each app, each through its own
// FaultyNetwork. fast-check draws a sequence of steps: a save through either app, two
// to five saves at once through both, dropping one client's connection (cut or
// stalled), reconnecting it, moving it to the other app, and, where the
// configuration has them, a lost notification at one app, a publish that throws, and
// an app's subscriber losing its Redis connection. After the last step the faults
// stop and every network comes back, and the run checks:
//
//   - the successful writes have versions 1 to n with no gap, and the tenant ends at n;
//   - before a deadline, every client holds the database's version and flags;
//   - the versions each client applied strictly increase;
//   - every snapshot a client applied holds the flags of its version, as the writes
//     in version order give them.
//
// Then, with every client connected and up to date, the run saves 3 or 4 different
// flags at once and checks the same again, three times. A client whose connection
// stays open gets these versions only from a notification, the poll or a re-check
// after its app's subscriber reconnected.
//
// The deadline only keeps a run that does not converge from waiting forever; the
// simulation makes no claim about how fast clients converge.

export const CLIENTS = 4;
export const MAX_STEPS = 24;
export const HEARTBEAT_MS = 100;
export const POLL_MS = 100;
export const DEADLINE_MS = 5000;
export const SPLIT_DELAY_MS = 25;
export const SIMULATION = runParams(20);
const KEYS = ['alpha', 'beta', 'gamma', 'delta'] as const;

export const SIMULATION_LABEL = `(seed ${SIMULATION.seed}, ${SIMULATION.numRuns} runs of up to ${MAX_STEPS} steps)`;

/** How notifications behave in a configuration. */
export type Notifications =
  /** Every one is delivered; only the steps that reset a subscriber lose some. */
  | 'delivered'
  /** Every one is lost at every app. */
  | 'dropped'
  /** Steps lose them at one app, make publishes throw, and reset subscribers. */
  | 'faulty';

export interface Configuration {
  /** The safety poll, every POLL_MS, or none. */
  readonly poll: boolean;
  readonly notifications: Notifications;
  /** Whether a stream that opens is read for at once. */
  readonly replay: boolean;
  /** A broken read of the version and the flags SPLIT_DELAY_MS apart. */
  readonly splitRead?: boolean;
}

interface SaveOp {
  readonly key: string;
  /** Delete the flag when it exists; otherwise update it, or create it when it does not. */
  readonly remove: boolean;
  readonly enabled: boolean;
  readonly rules: Rule[];
  readonly rolloutBasisPoints: number;
  /** The app the save goes through. */
  readonly via: number;
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
  /** The app the client's next connection goes to. */
  at: number;
}

/** What the runs of one property did, to show that they exercised each step and fault. */
export interface Tally {
  runs: number;
  saves: number;
  concurrentSaves: number;
  /** Saves refused with 404 or 409 because a concurrent save of the key won. */
  conflicts: number;
  cuts: number;
  stalls: number;
  reconnects: number;
  moves: number;
  /** Stalled connections that a client's read timeout gave up on. */
  readTimeouts: number;
  /** Connections that clients opened after their first one. */
  reopened: number;
  /** Connections answered by another app than the client's connection before. */
  switched: number;
  lostNotifications: number;
  failedPublishes: number;
  subscriberResets: number;
  /** Snapshot events the apps sent, by what woke the read that found them. */
  delivered: Deliveries;
}

export const newTally = (): Tally => ({
  runs: 0,
  saves: 0,
  concurrentSaves: 0,
  conflicts: 0,
  cuts: 0,
  stalls: 0,
  reconnects: 0,
  moves: 0,
  readTimeouts: 0,
  reopened: 0,
  switched: 0,
  lostNotifications: 0,
  failedPublishes: 0,
  subscriberResets: 0,
  delivered: { connect: 0, notification: 0, ready: 0, poll: 0 },
});

const byKey = (flags: Iterable<Flag>): Flag[] =>
  [...flags].toSorted((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

/** The environment of one configuration and the faults its steps control. */
export interface Simulation {
  readonly env: Environment;
  readonly faults: BusFaults;
  readonly configuration: Configuration;
  close(): Promise<void>;
}

export async function startSimulation(
  label: string,
  configuration: Configuration,
): Promise<Simulation> {
  const faults = new BusFaults();
  faults.dropAll = configuration.notifications === 'dropped';
  const configure = (config: Config): Config => ({
    ...config,
    stream: { heartbeatMs: HEARTBEAT_MS, safetyPollMs: configuration.poll ? POLL_MS : null },
  });
  const changes = [0, 1].map((index): AppChanges => ({
    configure,
    override: (builder) => {
      let changed: TestingModuleBuilder = withFaultyBus(builder, faults, index);
      if (!configuration.replay) {
        changed = changed.overrideProvider(StreamHub).useFactory({
          factory: (config: Config, reader: SnapshotReader) => new NoReplayHub(config, reader),
          inject: [CONFIG, SnapshotReader],
        });
      }
      if (configuration.splitRead === true) {
        changed = changed.overrideProvider(SnapshotReader).useFactory({
          factory: (db: TenantDatabase, cache: FlagsCache) => new SplitSnapshotReader(db, cache),
          inject: [TenantDatabase, FlagsCache],
        });
      }
      return changed;
    },
  }));
  const env = await startEnvironment(label, changes);
  return { env, faults, configuration, close: () => env.close() };
}

class Run {
  /** Successful writes by the version the API answered with. */
  readonly writes = new Map<number, Write>();
  private readonly deliveredBefore: Deliveries[];

  private constructor(
    private readonly sim: Simulation,
    readonly tenantId: string,
    readonly clients: readonly SimClient[],
    readonly tally: Tally,
  ) {
    this.deliveredBefore = this.hubs().map((hub) => Object.assign({}, hub.delivered));
  }

  static async start(sim: Simulation, tally: Tally): Promise<Run> {
    const { env } = sim;
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
    const clients = Array.from({ length: CLIENTS }, (_, index): SimClient => {
      const at = index % env.apis.length;
      const network = new FaultyNetwork();
      network.aim(env.apis[at]!.base);
      const client = new FlagsClient({
        url: env.apis[at]!.base,
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
      return { network, client, applied, at };
    });
    return new Run(sim, tenantId, clients, tally);
  }

  get env(): Environment {
    return this.sim.env;
  }

  get faults(): BusFaults {
    return this.sim.faults;
  }

  hubs(): StreamHub[] {
    return this.env.apis.map((api) => api.app.get(StreamHub));
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
        const reply = await this.env.send(this.env.world.people.editorOfA, call, op.via);
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
    this.faults.clear();
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
    for (const { network } of this.clients) {
      this.tally.reopened += Math.max(0, network.opened - 1);
      this.tally.switched += network.switched;
    }
    this.hubs().forEach((hub, index) => {
      const before = this.deliveredBefore[index] as Deliveries;
      for (const cause of Object.keys(before) as (keyof Deliveries)[]) {
        this.tally.delivered[cause] += hub.delivered[cause] - before[cause];
      }
    });
  }
}

interface Model {
  readonly down: Set<number>;
}

type Step = fc.AsyncCommand<Model, Run>;

const describeOp = (op: SaveOp): string =>
  `${op.key}${op.remove ? ' remove' : ''} ${op.enabled ? 'on' : 'off'} ${op.rolloutBasisPoints} rules ${op.rules.length} via ${op.via}`;

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

/**
 * The client's connection is cut and it reconnects to the other app, as after a
 * load balancer moves it. The step waits until that connection has opened.
 */
class Move implements Step {
  constructor(readonly client: number) {}
  check(model: Readonly<Model>): boolean {
    return !model.down.has(this.client);
  }
  async run(_model: Model, run: Run): Promise<void> {
    const sim = run.clients[this.client];
    if (sim === undefined) return;
    run.tally.moves += 1;
    const { network } = sim;
    await eventually(() => network.opened > 0, `client ${this.client}'s first connection`);
    const opened = network.opened;
    sim.at = (sim.at + 1) % run.env.apis.length;
    network.aim(run.env.apis[sim.at]!.base);
    network.cut();
    await eventually(
      () => network.opened > opened,
      `client ${this.client}'s connection to app ${sim.at}`,
    );
  }
  toString(): string {
    return `move(client ${this.client} to the other app)`;
  }
}

class LoseNotification implements Step {
  constructor(readonly app: number) {}
  check(): boolean {
    return true;
  }
  async run(_model: Model, run: Run): Promise<void> {
    run.tally.lostNotifications += 1;
    run.faults.dropNextAt(this.app);
  }
  toString(): string {
    return `lose the next notification at app ${this.app}`;
  }
}

class PublisherThrows implements Step {
  check(): boolean {
    return true;
  }
  async run(_model: Model, run: Run): Promise<void> {
    run.tally.failedPublishes += 1;
    run.faults.failNextPublish();
  }
  toString(): string {
    return 'the next publish throws';
  }
}

class ResetSubscriber implements Step {
  constructor(readonly app: number) {}
  check(): boolean {
    return true;
  }
  async run(_model: Model, run: Run): Promise<void> {
    run.tally.subscriberResets += 1;
    const { env } = run;
    await killConnection(env.redis, subscriberName(env.redisPrefix, env.apis[this.app]!.instance));
  }
  toString(): string {
    return `reset the Redis subscriber of app ${this.app}`;
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
    via: fc.nat(1),
  },
  { noNullPrototype: true },
);

function steps(configuration: Configuration) {
  const app = fc.nat(1);
  const client = fc.nat(CLIENTS - 1);
  const kinds: fc.Arbitrary<Step>[] = [
    saveOp.map((op): Step => new Save([op])),
    fc.array(saveOp, { minLength: 2, maxLength: 5 }).map((ops): Step => new Save(ops)),
    fc
      .record(
        { client, mode: fc.constantFrom<DropMode>('cut', 'stall') },
        { noNullPrototype: true },
      )
      .map(({ client: index, mode }): Step => new Drop(index, mode)),
    client.map((index): Step => new Reconnect(index)),
    client.map((index): Step => new Move(index)),
  ];
  if (configuration.notifications === 'faulty') {
    kinds.push(
      app.map((index): Step => new LoseNotification(index)),
      fc.constant(null).map((): Step => new PublisherThrows()),
    );
  }
  if (configuration.notifications !== 'dropped') {
    kinds.push(app.map((index): Step => new ResetSubscriber(index)));
  }
  return fc.commands<Model, Run, false>(kinds, { maxCommands: MAX_STEPS, size: 'max' });
}

/** Three rounds of saves of 3 or 4 different flags, which all succeed when sent at once. */
const finalRounds = fc.array(
  fc.uniqueArray(saveOp, { minLength: 3, maxLength: KEYS.length, selector: (op) => op.key }),
  { minLength: 3, maxLength: 3 },
);

export function convergence(sim: Simulation, tally: Tally = newTally()) {
  return fc.asyncProperty(steps(sim.configuration), finalRounds, async (commands, rounds) => {
    const run = await Run.start(sim, tally);
    try {
      await fc.asyncModelRun(() => ({ model: { down: new Set<number>() }, real: run }), commands);
      await run.settle(rounds);
    } finally {
      await run.close();
      sim.faults.clear();
    }
  });
}

export const PARAMS = { seed: SIMULATION.seed, numRuns: SIMULATION.numRuns, endOnFailure: true };

/** The message of the error that made the property fail for a configuration. */
export async function failureOf(label: string, configuration: Configuration): Promise<string> {
  const sim = await startSimulation(label, configuration);
  try {
    const details = await fc.check(convergence(sim), PARAMS);
    if (!details.failed) return 'the property held';
    const error = details.errorInstance;
    return error instanceof Error ? error.message : String(error);
  } finally {
    await sim.close();
  }
}

/** A broken fan-out: a stream that opens is not read for, so it waits for the next change. */
export class NoReplayHub extends StreamHub {
  protected override connected(): void {}
}

/** A broken read: the version in one transaction, the flags in another, 25 ms later. */
export class SplitSnapshotReader extends SnapshotReader {
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
