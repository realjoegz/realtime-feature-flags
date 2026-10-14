import { describe, expect, it } from 'vitest';
import { Arrivals } from '../src/arrivals.ts';
import {
  checkConnectsLogged,
  clientsByReplica,
  type Mark,
  phaseTotals,
  reconnects,
  replicaOf,
  runChanges,
  type Save,
  timeChange,
} from '../src/run.ts';

const URL = 'http://127.0.0.1:4001/tenants/t/flags/dark-mode';

/** A reply whose body is read a turn later, after read() has run. */
function reply(status: number, body: string, read: () => void) {
  return {
    status,
    text: async () => {
      await Promise.resolve();
      read();
      return body;
    },
  };
}

/**
 * A stack on a fake clock with two clients: each PUT bumps the version, the reply's
 * headers come 3 ms after the request is sent and its body 2 ms later; client 0
 * hears the change 1 ms after the request, client 1 4 ms after the body.
 */
function fakeStack() {
  const clock = { now: 100 };
  const arrivals = new Arrivals(2);
  let version = 10;
  arrivals.record(0, version, 0);
  arrivals.record(1, version, 0);
  const puts: { at: number; body: unknown; behind: boolean; authorization: string | null }[] = [];
  const fetch: Save = async (url, init) => {
    expect(url).toBe(URL);
    expect(init.method).toBe('PUT');
    puts.push({
      at: clock.now,
      body: init.body,
      behind: !arrivals.allAt(version),
      authorization: new Headers(init.headers).get('authorization'),
    });
    version += 1;
    const saved = version;
    const sentAt = clock.now;
    arrivals.record(0, saved, sentAt + 1);
    clock.now = sentAt + 3;
    await Promise.resolve();
    return reply(200, JSON.stringify({ version: saved }), () => {
      clock.now = sentAt + 5;
      setTimeout(() => {
        clock.now = sentAt + 9;
        arrivals.record(1, saved, clock.now);
      }, 1);
    });
  };
  return { clock, arrivals, fetch, puts, saves: () => puts.length };
}

const refused: Save = async () => reply(409, '{"message":"no"}', () => {});
const lost: Save = async () => reply(200, '{"version":20}', () => {});

/** Counters that move with the number of saves, so each reading shows when it was taken. */
const counters = (saves: number): Mark => ({
  deliveries: { connect: 0, ready: saves, poll: 2 * saves },
  reconnects: 10 * saves,
  errors: saves,
});

describe('the run', () => {
  it('t0 is read before the PUT and the round trip after its body', async () => {
    const clock = { now: 100 };
    const arrivals = new Arrivals(2);
    arrivals.record(0, 11, 50);
    arrivals.record(1, 11, 50);
    const sent: number[] = [];
    const fetch: Save = async (_url, init) => {
      sent.push(clock.now);
      expect(init.body).toBe('{"rolloutBasisPoints":1234}');
      // The headers come at 103, and client 0 heard the change at 102, before them.
      clock.now = 103;
      arrivals.record(0, 12, 102);
      await Promise.resolve();
      return reply(200, '{"version":12}', () => {
        // The body has been read at 106. Client 1 skips 12 and gets 13 at 109.
        clock.now = 106;
        setTimeout(() => arrivals.record(1, 13, 109), 1);
      });
    };
    const timer = { url: URL, token: 't', fetch, now: () => clock.now, arrivals, deadlineMs: 1000 };
    const change = await timeChange(timer, 'measured', '{"rolloutBasisPoints":1234}');
    expect(sent).toEqual([100]);
    expect(change).toEqual({ phase: 'measured', version: 12, saveMs: 6, lastClientMs: 9 });

    await expect(timeChange({ ...timer, fetch: refused }, 'measured', '{}')).rejects.toThrow(
      `PUT ${URL}: 409 {"message":"no"}`,
    );
    await expect(
      timeChange({ ...timer, fetch: lost, deadlineMs: 20 }, 'measured', '{}'),
    ).rejects.toThrow('2 clients did not reach version 20 within 20 ms');
  });

  it('with 2 warm-up and 3 measured changes, each PUT waits for every client', async () => {
    const stack = fakeStack();
    const connected = counters(0);
    const progress: number[] = [];
    const loop = {
      url: URL,
      token: 'token-1',
      fetch: stack.fetch,
      now: () => stack.clock.now,
      arrivals: stack.arrivals,
      deadlineMs: 1000,
      body: (index: number) => `body ${index}`,
      mark: async () => counters(stack.saves()),
      progress: (done: number, total: number) => progress.push(done / total),
    };
    const { changes, warmedUp, finished } = await runChanges({ ...loop, warmup: 2, changes: 3 });

    expect(changes.map((change) => change.phase)).toEqual([
      'warmup',
      'warmup',
      'measured',
      'measured',
      'measured',
    ]);
    expect(changes.map((change) => change.version)).toEqual([11, 12, 13, 14, 15]);
    for (const change of changes) expect(change).toMatchObject({ saveMs: 5, lastClientMs: 9 });
    expect(stack.puts.map((put) => put.body)).toEqual([0, 1, 2, 3, 4].map((i) => `body ${i}`));
    expect(stack.puts.every((put) => !put.behind)).toBe(true);
    expect(stack.puts.every((put) => put.authorization === 'Bearer token-1')).toBe(true);
    expect(progress).toEqual([1 / 5, 2 / 5, 3 / 5, 4 / 5, 1]);
    expect(warmedUp).toEqual(counters(2));
    expect(finished).toEqual(counters(5));
    expect(phaseTotals(changes, 'warmup', connected, warmedUp)).toEqual({
      changes: 2,
      reconnects: 20,
      clientErrors: 2,
      otherDeliveries: { connect: 0, ready: 2, poll: 4 },
    });
    expect(phaseTotals(changes, 'measured', warmedUp, finished)).toEqual({
      changes: 3,
      reconnects: 30,
      clientErrors: 3,
      otherDeliveries: { connect: 0, ready: 3, poll: 6 },
    });

    const noWarmup = fakeStack();
    const cold = await runChanges({
      ...loop,
      fetch: noWarmup.fetch,
      now: () => noWarmup.clock.now,
      arrivals: noWarmup.arrivals,
      mark: async () => counters(noWarmup.saves()),
      warmup: 0,
      changes: 2,
    });
    expect(cold.changes.map((change) => change.phase)).toEqual(['measured', 'measured']);
    expect(cold.warmedUp).toEqual(counters(0));
    expect(cold.finished).toEqual(counters(2));
  });

  it('alternates clients between replicas, counts reconnects and fails on fewer logged snapshots than clients', () => {
    expect([0, 1, 2, 3, 4].map(replicaOf)).toEqual([0, 1, 0, 1, 0]);
    expect(clientsByReplica(5, ['api-1', 'api-2'])).toEqual({ 'api-1': 3, 'api-2': 2 });
    expect(clientsByReplica(100, ['api-1', 'api-2'])).toEqual({ 'api-1': 50, 'api-2': 50 });
    expect(reconnects([1, 1, 1])).toBe(0);
    expect(reconnects([1, 3, 2, 0])).toBe(3);

    const before = { connect: 4, ready: 0, poll: 1 };
    expect(() => checkConnectsLogged(before, { connect: 9, ready: 0, poll: 1 }, 5)).not.toThrow();
    expect(() => checkConnectsLogged(before, { connect: 8, ready: 0, poll: 1 }, 5)).toThrow(
      'the replicas logged 4 snapshots sent to 5 new connections',
    );
  });
});
