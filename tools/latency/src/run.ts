import type { Arrivals } from './arrivals.ts';
import { deliveriesBetween, totalDeliveries } from './deliveries.ts';
import type { Change, OtherDeliveries, Phase, PhaseTotals } from './results.ts';

// The steps of a run that do not depend on the stack: which replica each client
// connects to, the closed loop of timed changes, and the totals of each phase.
// main.ts gives them the real fetch, clock and counters; the tests give them fakes.

/** Replica 0 or 1 for client number index: the clients alternate between the two. */
export function replicaOf(index: number): 0 | 1 {
  return index % 2 === 0 ? 0 : 1;
}

/** How many of count clients connect to each replica, by name. */
export function clientsByReplica(
  count: number,
  names: readonly [string, string],
): Record<string, number> {
  const split = [0, 0];
  for (let index = 0; index < count; index += 1) split[replicaOf(index)]! += 1;
  return { [names[0]]: split[0]!, [names[1]]: split[1]! };
}

/** The connections the clients opened after their first one, from each client's count. */
export function reconnects(connects: readonly number[]): number {
  return connects.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

/** The counters at one moment of the run. */
export interface Mark {
  /** The snapshots the replicas had logged as sent after a wake-up other than a notification. */
  readonly deliveries: OtherDeliveries;
  readonly reconnects: number;
  /** Failures the clients had reported through onError. */
  readonly errors: number;
}

/**
 * Fails unless the replicas logged at least one snapshot per client between the
 * readings before and after the clients connected. Each new connection gets its
 * snapshot from a read that a stream opening asked for, so fewer means that the log
 * lines this tool counts are missing or have changed.
 */
export function checkConnectsLogged(
  before: OtherDeliveries,
  after: OtherDeliveries,
  clients: number,
): void {
  const logged = totalDeliveries(deliveriesBetween(before, after));
  if (logged < clients) {
    throw new Error(
      `the replicas logged ${logged} snapshots sent to ${clients} new connections; the lines this tool counts (apps/api/src/stream/stream-hub.ts) are missing or have changed`,
    );
  }
}

/** The totals of phase: its changes, and what the counters moved between from and to. */
export function phaseTotals(
  changes: readonly Change[],
  phase: Phase,
  from: Mark,
  to: Mark,
): PhaseTotals {
  return {
    changes: changes.filter((change) => change.phase === phase).length,
    reconnects: to.reconnects - from.reconnects,
    clientErrors: to.errors - from.errors,
    otherDeliveries: deliveriesBetween(from.deliveries, to.deliveries),
  };
}

/** The phase of change number index when the first warmup changes are the warm-up. */
export function phaseOf(index: number, warmup: number): Phase {
  return index < warmup ? 'warmup' : 'measured';
}

/** The part of fetch that a save uses. */
export type Save = (
  url: string,
  init: RequestInit,
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface ChangeTimer {
  /** The flag's URL on the replica that every save goes to. */
  readonly url: string;
  readonly token: string;
  readonly fetch: Save;
  /** The clock of every time in the run: performance.now() in main.ts. */
  readonly now: () => number;
  /** Where the clients' onChange calls are recorded, on the same clock. */
  readonly arrivals: Arrivals;
  /** How long a change may take to reach every client before the run fails. */
  readonly deadlineMs: number;
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

/**
 * Saves body with a PUT and waits until every client holds the saved version or a
 * later one. t0 is read just before the request is sent; the save round trip ends
 * once the response body has been read; the time to the last client runs from t0
 * to the latest of the clients' first arrivals at the saved version or a later one.
 */
export async function timeChange(timer: ChangeTimer, phase: Phase, body: string): Promise<Change> {
  timer.arrivals.clear();
  const sentAt = timer.now();
  const response = await timer.fetch(timer.url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${timer.token}`, 'content-type': 'application/json' },
    body,
  });
  const text = await response.text();
  const repliedAt = timer.now();
  if (response.status !== 200) throw new Error(`PUT ${timer.url}: ${response.status} ${text}`);
  const { version } = JSON.parse(text) as { version?: unknown };
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new Error(`PUT ${timer.url} gave no version: ${text}`);
  }
  await timer.arrivals.whenAllAt(version, timer.deadlineMs);
  return {
    phase,
    version,
    saveMs: round(repliedAt - sentAt),
    lastClientMs: round(timer.arrivals.timeToLastClient(version, sentAt)),
  };
}

export interface ChangeLoop extends ChangeTimer {
  readonly warmup: number;
  readonly changes: number;
  /** The PUT body of change number index. */
  readonly body: (index: number) => string;
  /** Reads the counters: once when the warm-up ends, once after the last change. */
  readonly mark: () => Promise<Mark>;
  readonly progress?: (done: number, total: number) => void;
}

export interface LoopResult {
  /** Every change in the order saved, the warm-up first. */
  readonly changes: readonly Change[];
  /** The counters when the warm-up ended, before the first measured change. */
  readonly warmedUp: Mark;
  /** The counters after the last change. */
  readonly finished: Mark;
}

/** A closed loop: warmup then changes timed changes, one at a time. */
export async function runChanges(loop: ChangeLoop): Promise<LoopResult> {
  if (!Number.isSafeInteger(loop.warmup) || loop.warmup < 0) throw new RangeError('warmup');
  if (!Number.isSafeInteger(loop.changes) || loop.changes < 1) throw new RangeError('changes');
  const changes: Change[] = [];
  const steps = loop.warmup + loop.changes;
  let warmedUp: Mark | undefined;
  for (let index = 0; index < steps; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- once, between the phases
    if (index === loop.warmup) warmedUp = await loop.mark();
    // eslint-disable-next-line no-await-in-loop -- a closed loop: one change at a time
    changes.push(await timeChange(loop, phaseOf(index, loop.warmup), loop.body(index)));
    loop.progress?.(index + 1, steps);
  }
  const finished = await loop.mark();
  if (warmedUp === undefined) throw new Error('the warm-up never ended');
  return { changes, warmedUp, finished };
}
