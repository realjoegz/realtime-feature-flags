import { setTimeout as sleep } from 'node:timers/promises';

// The first connection after "docker compose up" can fail for a few seconds even when
// the Postgres container reports healthy: port forwarding lags, and a server that is
// still starting answers 57P03. Those errors are retried until a deadline. Anything
// else (a wrong password, a missing database) fails at once, because waiting cannot
// fix it.

export interface RetryOptions {
  readonly deadlineMs: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export class DatabaseUnreachableError extends Error {
  constructor(
    readonly attempts: number,
    readonly elapsedMs: number,
    cause: unknown,
  ) {
    super(
      `database not reachable after ${attempts} attempts in ${elapsedMs} ms: ${messageOf(cause)}`,
      { cause },
    );
    this.name = 'DatabaseUnreachableError';
  }
}

export async function withConnectRetry<T>(
  attempt: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const started = performance.now();
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  // Each attempt starts only after the previous one failed and the delay passed.
  for (let attempts = 1; ; attempts += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- attempts run one after another
      return await attempt();
    } catch (error) {
      if (!isTransientConnectError(error)) throw error;
      // Unrounded, so the loop never gives up before the deadline; a timer can also
      // fire up to a millisecond early, which the next turn of the loop absorbs.
      const elapsedMs = performance.now() - started;
      const remainingMs = options.deadlineMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new DatabaseUnreachableError(attempts, Math.round(elapsedMs), error);
      }
      const delayMs = Math.min(
        initialDelayMs * 2 ** (attempts - 1),
        maxDelayMs,
        Math.ceil(remainingMs),
      );
      options.onRetry?.(attempts, error, delayMs);
      // eslint-disable-next-line no-await-in-loop -- the delay between two attempts
      await sleep(delayMs);
    }
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  // SQLSTATE cannot_connect_now: the server is starting up or shutting down.
  '57P03',
]);

const TRANSIENT_MESSAGES = [
  // pg: the server (or a port forwarder in front of it) closed the socket.
  'Connection terminated unexpectedly',
  // pg-pool: connectionTimeoutMillis passed.
  'timeout exceeded when trying to connect',
  // pg Client: connectionTimeoutMillis passed.
  'Connection terminated due to connection timeout',
];

export function isTransientConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // Node tries each address of a host name and reports every failure together.
  if (error instanceof AggregateError) return error.errors.some(isTransientConnectError);
  return TRANSIENT_MESSAGES.some((message) => error.message.includes(message));
}

function messageOf(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(messageOf).join(', ');
  }
  return error instanceof Error ? error.message : String(error);
}
