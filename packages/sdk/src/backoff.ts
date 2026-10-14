export interface ReconnectOptions {
  /** The ceiling of the first delay. Default 1000 ms. */
  readonly initialMs?: number;
  /** The highest ceiling. Default 30000 ms. */
  readonly maxMs?: number;
}

export const DEFAULT_RECONNECT = { initialMs: 1000, maxMs: 30_000 } as const;

/**
 * The wait before reconnect attempt number `failures` (0 after a connection that
 * opened): capped exponential backoff with jitter. The ceiling doubles with each
 * failure in a row, up to maxMs, and the delay is drawn between half the ceiling and
 * the ceiling, so clients that lost the same server do not all come back at once,
 * and no client retries without waiting.
 */
export function reconnectDelay(
  failures: number,
  options: Required<ReconnectOptions>,
  random: () => number,
): number {
  const ceiling = Math.min(options.maxMs, options.initialMs * 2 ** Math.min(failures, 52));
  const jitter = Math.min(Math.max(random(), 0), 1);
  return ceiling / 2 + (ceiling / 2) * jitter;
}
