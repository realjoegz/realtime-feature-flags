import { type SseEvent, SseParser } from '@rff/sdk';
import type { Reply } from './api.js';

// GET /sdk/stream read with fetch, as the tests need it: the status and headers,
// every byte as text for format and canary checks, and the events parsed by the
// SDK's parser (which has tests of its own in packages/sdk).

export interface OpenStream {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Every byte received so far, decoded. */
  readonly text: string;
  readonly events: readonly SseEvent[];
  /** How many heartbeat frames arrived so far. */
  readonly heartbeats: number;
  /** Settles when the body ends ("ended") or fails ("failed"). */
  readonly ended: Promise<'ended' | 'failed'>;
  /** Resolves once condition holds, re-checked whenever bytes arrive, or rejects after timeoutMs. */
  until(condition: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** The whole reply, for a response that is not a stream; waits for its end. */
  reply(): Promise<Reply>;
  close(): void;
}

export interface StreamRequest {
  readonly authorization?: string;
  readonly lastEventId?: string;
  /** Appended to the path, for example "?cursor=4". */
  readonly query?: string;
}

export async function openStream(base: string, options: StreamRequest = {}): Promise<OpenStream> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.authorization !== undefined) headers['authorization'] = options.authorization;
  if (options.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;
  const controller = new AbortController();
  const response = await fetch(`${base}/sdk/stream${options.query ?? ''}`, {
    headers,
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  const decoder = new TextDecoder();
  const waiters = new Set<() => void>();
  let text = '';
  const notify = (): void => {
    for (const waiter of waiters) waiter();
  };
  const body = response.body;
  const ended: Promise<'ended' | 'failed'> = (async () => {
    if (body === null) return 'ended';
    const reader = body.getReader();
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- chunks arrive one after another
        const { done, value } = await reader.read();
        if (done) return 'ended';
        text += decoder.decode(value, { stream: true });
        parser.push(value);
        notify();
      }
    } catch {
      return 'failed';
    } finally {
      notify();
    }
  })();
  let finished = false;
  void ended.finally(() => {
    finished = true;
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    get text() {
      return text;
    },
    events,
    get heartbeats() {
      return text.split(': hb\n\n').length - 1;
    },
    ended,
    until(condition, what, timeoutMs = 5000) {
      return new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (condition()) {
            done();
            resolve();
          } else if (finished) {
            done();
            reject(
              new Error(`the stream ended before ${what}; it received ${JSON.stringify(text)}`),
            );
          }
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
        }, timeoutMs);
        const done = (): void => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    async reply() {
      await ended;
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: keep the text.
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        text,
        body: parsed,
      };
    },
    close() {
      controller.abort();
    },
  };
}

/** The data of each snapshot event, parsed. */
export function snapshotsOf(stream: OpenStream): unknown[] {
  return stream.events
    .filter((event) => event.type === 'snapshot')
    .map((event) => JSON.parse(event.data) as unknown);
}
