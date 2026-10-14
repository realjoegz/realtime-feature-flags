// A parser for the text/event-stream format, following the event stream
// interpretation rules of the WHATWG HTML standard (section 9.2.6). Node 24 has no
// EventSource, and a browser's EventSource cannot send an Authorization header, so
// the client reads the response body with fetch and parses it here.
//
// Bytes arrive in chunks that can end anywhere: inside a field, inside a UTF-8
// sequence, or between the CR and the LF of a CRLF. The decoder keeps an incomplete
// UTF-8 sequence for the next chunk, and a CR at the end of a chunk is remembered so
// that an LF at the start of the next one does not end a second, empty line. A
// leading byte order mark is removed by the decoder.
//
// A blank line dispatches the event built from the lines before it. A blank line
// with no data before it dispatches nothing: this covers the newline that Nest writes
// when it sends the response headers. Lines that start with a colon are comments,
// which the server sends as heartbeats. The retry field is not used: the client's
// own backoff decides when it reconnects.

export interface SseEvent {
  /** The event field, or "message" when the event had none. */
  readonly type: string;
  /** The data lines joined by "\n". */
  readonly data: string;
  /** The last id field the stream sent, at or before this event; "" when none. */
  readonly lastEventId: string;
}

const LF = 0x0a;
const CR = 0x0d;

export class SseParser {
  readonly #onEvent: (event: SseEvent) => void;
  readonly #decoder = new TextDecoder('utf-8');
  /** The start of a line whose end has not arrived yet. */
  #partial = '';
  /** The previous chunk ended with CR, so an LF that starts this one belongs to it. */
  #afterCR = false;
  #data = '';
  #type = '';
  #lastEventId = '';

  constructor(onEvent: (event: SseEvent) => void) {
    this.#onEvent = onEvent;
  }

  /** Parses the next chunk of the body and dispatches each event it completes. */
  push(chunk: Uint8Array): void {
    const text = this.#decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === LF && this.#afterCR) {
        this.#afterCR = false;
        start = index + 1;
        continue;
      }
      this.#afterCR = false;
      if (code === LF || code === CR) {
        const line = this.#partial + text.slice(start, index);
        this.#partial = '';
        start = index + 1;
        this.#afterCR = code === CR;
        this.#line(line);
      }
    }
    this.#partial += text.slice(start);
  }

  #line(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#type = value;
        break;
      case 'data':
        this.#data += `${value}\n`;
        break;
      case 'id':
        // The standard ignores an id that contains U+0000.
        if (!value.includes('\u0000')) this.#lastEventId = value;
        break;
      default:
      // retry and unknown fields are ignored.
    }
  }

  #dispatch(): void {
    const data = this.#data;
    const type = this.#type;
    this.#data = '';
    this.#type = '';
    if (data === '') return;
    this.#onEvent({
      type: type === '' ? 'message' : type,
      data: data.endsWith('\n') ? data.slice(0, -1) : data,
      lastEventId: this.#lastEventId,
    });
  }
}
