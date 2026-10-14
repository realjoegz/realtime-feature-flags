import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { createPool, type LogSink } from '../src/database/pool.js';
import {
  DatabaseUnreachableError,
  isTransientConnectError,
  withConnectRetry,
} from '../src/database/retry.js';
import { adminClient, harness } from './harness/context.js';
import { withCredentials } from './harness/settings.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** A port that nothing listens on (it was free a moment ago). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** Starts forwarding 127.0.0.1:port to the test Postgres. */
async function forward(port: number): Promise<void> {
  const target = new URL(harness().adminUrl);
  const sockets = new Set<Socket>();
  const server = createServer((inbound) => {
    const outbound = createConnection(Number(target.port), target.hostname);
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    }
    inbound.pipe(outbound).pipe(inbound);
  });
  server.on('close', () => sockets.forEach((socket) => socket.destroy()));
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  servers.push(server);
}

function appUrlOnPort(port: number): string {
  const url = new URL(harness().appUrl);
  url.port = String(port);
  return url.toString();
}

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function recordingLogger(): LogSink & { errors: string[] } {
  const errors: string[] = [];
  return { errors, log: () => {}, warn: () => {}, error: (message) => errors.push(message) };
}

describe('database connection at start-up', () => {
  it('retries until a database that comes up late accepts the connection', async () => {
    const port = await freePort();
    const attempts: number[] = [];
    setTimeout(() => void forward(port), 800);
    const client = await withConnectRetry(
      () => connectClient(appUrlOnPort(port), 'rff-test-retry'),
      {
        deadlineMs: 15_000,
        onRetry: (attempt) => attempts.push(attempt),
      },
    );
    try {
      const { rows } = await client.query('SELECT current_user AS role');
      expect(rows).toEqual([{ role: 'rff_app' }]);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.end();
    }
  });

  it('gives up at the deadline, never waits past it, and says how many attempts it made', async () => {
    const port = await freePort();
    const waitsEndAt: number[] = [];
    const started = performance.now();
    const failure = await withConnectRetry(
      () => connectClient(appUrlOnPort(port), 'rff-test-retry'),
      {
        deadlineMs: 1000,
        onRetry: (_attempt, _error, delayMs) =>
          waitsEndAt.push(performance.now() - started + delayMs),
      },
    ).catch((error: unknown) => error);
    const elapsed = performance.now() - started;
    // The backoff doubles from 100 ms, so an uncapped fourth wait would end near 1500 ms.
    expect(waitsEndAt.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...waitsEndAt)).toBeLessThanOrEqual(1000 + 25);
    expect(failure).toBeInstanceOf(DatabaseUnreachableError);
    expect((failure as DatabaseUnreachableError).attempts).toBeGreaterThanOrEqual(3);
    expect((failure as Error).message).toMatch(
      /^database not reachable after \d+ attempts in \d+ ms: .*ECONNREFUSED/,
    );
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(3000);
  });

  it('a wrong password fails at the first attempt instead of waiting for the deadline', async () => {
    let attempts = 0;
    const started = performance.now();
    const failure = await withConnectRetry(
      () => {
        attempts += 1;
        return connectClient(
          withCredentials(harness().appUrl, 'rff_app', 'wrong'),
          'rff-test-retry',
        );
      },
      { deadlineMs: 10_000 },
    ).catch((error: unknown) => error);
    expect(attempts).toBe(1);
    expect((failure as { code?: string }).code).toBe('28P01');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('treats refused connections and a starting server as transient, and nothing else', () => {
    expect(isTransientConnectError(coded('ECONNREFUSED'))).toBe(true);
    expect(isTransientConnectError(coded('57P03'))).toBe(true);
    expect(isTransientConnectError(new AggregateError([coded('ECONNREFUSED')]))).toBe(true);
    expect(isTransientConnectError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientConnectError(coded('28P01'))).toBe(false);
    expect(isTransientConnectError(coded('3D000'))).toBe(false);
    expect(isTransientConnectError('ECONNREFUSED')).toBe(false);
  });
});

describe('connection pool', () => {
  it('an idle connection killed by the server is logged, and the pool keeps serving', async () => {
    const logger = recordingLogger();
    const pool = createPool({ url: harness().appUrl, poolMax: 1, connectDeadlineMs: 0 }, logger);
    try {
      expect(pool.listenerCount('error')).toBe(1);
      const first = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = first.rows[0]?.pid;
      const admin = await adminClient();
      try {
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      } finally {
        await admin.end();
      }
      await vi.waitFor(() => expect(logger.errors).toHaveLength(1), { timeout: 5000 });
      expect(logger.errors[0]).toMatch(
        /^idle database connection to rff_app@127\.0\.0\.1:\d+\/rff_test_/,
      );
      expect(logger.errors[0]).not.toContain(new URL(harness().appUrl).password);
      const second = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(second.rows[0]?.pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });
});
