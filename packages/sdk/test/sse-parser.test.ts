import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type SseEvent, SseParser } from '../src/index.ts';
import { label, runParams } from './support/fc-params.ts';

const encoder = new TextEncoder();

function parse(chunks: readonly (string | Uint8Array)[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks)
    parser.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  return events;
}

/** bytes cut at the given offsets, in order; an offset of 0 or the length gives an empty chunk. */
function split(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const cuts = [...new Set(offsets.map((offset) => offset % (bytes.length + 1)))].toSorted(
    (x, y) => x - y,
  );
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    chunks.push(bytes.subarray(start, cut));
    start = cut;
  }
  return chunks;
}

// The stream format, written independently of the parser: each line gets one of the
// three line ends, comments and fields the parser must skip sit between the fields,
// and events are separated by blank lines.

type LineEnd = '\n' | '\r\n' | '\r';

interface GeneratedEvent {
  readonly comments: readonly string[];
  readonly type: string | null;
  readonly id: string | null;
  readonly data: readonly string[];
  /** Whether each data line is written "data:value" instead of "data: value". */
  readonly tight: readonly boolean[];
  readonly ignored: readonly string[];
}

const lineText = fc
  .string({ unit: 'grapheme', maxLength: 12 })
  .map((s) => s.replace(/[\r\n]/g, ''));

const generatedEvent: fc.Arbitrary<GeneratedEvent> = fc.record({
  comments: fc.array(lineText, { maxLength: 2 }),
  type: fc.option(fc.constantFrom('snapshot', 'update', 'message', ''), { nil: null }),
  id: fc.option(fc.stringMatching(/^[0-9]{0,4}$/), { nil: null }),
  data: fc.array(lineText, { minLength: 1, maxLength: 3 }),
  tight: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  ignored: fc.array(fc.constantFrom('retry: 1000', 'ID: 99', 'Data: shout', 'x-extra: 1'), {
    maxLength: 2,
  }),
});

const stream = fc.record({
  leadingNewline: fc.boolean(),
  byteOrderMark: fc.boolean(),
  events: fc.array(generatedEvent, { maxLength: 6 }),
  ends: fc.array(fc.constantFrom<LineEnd>('\n', '\r\n', '\r'), { minLength: 64, maxLength: 64 }),
  heartbeats: fc.array(fc.nat(3), { minLength: 6, maxLength: 6 }),
  cuts: fc.array(fc.nat(), { maxLength: 40 }),
});

type StreamInput = typeof stream extends fc.Arbitrary<infer T> ? T : never;

function serialize(input: StreamInput): { bytes: Uint8Array; expected: SseEvent[] } {
  const lines: string[] = [];
  const expected: SseEvent[] = [];
  let lastEventId = '';
  input.events.forEach((event, index) => {
    for (let beat = 0; beat < (input.heartbeats[index] ?? 0); beat += 1) lines.push(': hb', '');
    lines.push(...event.comments.map((comment) => `:${comment}`));
    if (event.type !== null) lines.push(`event: ${event.type}`);
    lines.push(...event.ignored);
    if (event.id !== null) {
      lines.push(`id: ${event.id}`);
      lastEventId = event.id;
    }
    event.data.forEach((value, line) => {
      const tight = (event.tight[line] ?? false) && !value.startsWith(' ');
      lines.push(tight ? `data:${value}` : `data: ${value}`);
    });
    lines.push('');
    expected.push({
      type: event.type === null || event.type === '' ? 'message' : event.type,
      data: event.data.join('\n'),
      lastEventId,
    });
  });
  let text = input.leadingNewline ? '\n' : '';
  let previous: LineEnd | null = input.leadingNewline ? '\n' : null;
  lines.forEach((line, index) => {
    let end = input.ends[index % input.ends.length] ?? '\n';
    // After a CR, an empty line ended by LF would read as the LF of a CRLF.
    if (previous === '\r' && line === '' && end === '\n') end = '\r\n';
    text += line + end;
    previous = end;
  });
  const body = encoder.encode(text);
  if (!input.byteOrderMark) return { bytes: body, expected };
  const withMark = new Uint8Array(body.length + 3);
  withMark.set([0xef, 0xbb, 0xbf]);
  withMark.set(body, 3);
  return { bytes: withMark, expected };
}

const PARSER = runParams(300);

describe('SSE parser', () => {
  it(`events written with LF, CRLF or CR line ends, comments, heartbeats, ignored fields and multi-line data parse to the same events however the bytes are cut into chunks ${label(PARSER)}`, () => {
    fc.assert(
      fc.property(stream, (input) => {
        const { bytes, expected } = serialize(input);
        expect(parse([bytes])).toEqual(expected);
        expect(parse(split(bytes, input.cuts))).toEqual(expected);
        // One byte at a time cuts every CRLF and every UTF-8 sequence.
        expect(parse([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(expected);
      }),
      { seed: PARSER.seed, numRuns: PARSER.numRuns },
    );
  });

  it('ignores the newline Nest writes with the headers, and reads a snapshot event and heartbeats as Nest writes them', () => {
    // The bytes Nest 12 wrote in the spike for one snapshot event and two heartbeats.
    const nest = '\nevent: snapshot\nid: 8\ndata: {"version":8}\n\n: hb\n\n: hb\n\n';
    expect(parse([nest])).toEqual([{ type: 'snapshot', data: '{"version":8}', lastEventId: '8' }]);
    expect(parse(['\n', ': hb\n\n', ': hb\n\n'])).toEqual([]);
  });

  it('a CR that ends one chunk and an LF that starts the next end one line, not two', () => {
    // Read as two line ends, the empty line between them would dispatch "a" alone.
    expect(parse(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([
      { type: 'message', data: 'a\nb', lastEventId: '' },
    ]);
    expect(parse(['data: a\r\r'])).toEqual([{ type: 'message', data: 'a', lastEventId: '' }]);
  });

  it('removes one space after the colon and keeps a second, reads a line without a colon as a field with an empty value, ignores an id holding U+0000, carries an id over to later events, and dispatches no event without data and no event cut off by the end', () => {
    expect(parse(['data:  two spaces\n\n'])).toEqual([
      { type: 'message', data: ' two spaces', lastEventId: '' },
    ]);
    expect(parse(['data\ndata\n\n'])).toEqual([{ type: 'message', data: '\n', lastEventId: '' }]);
    expect(parse(['id: 4\ndata: a\n\nid: 5\u0000\ndata: b\n\ndata: c\n\nid\ndata: d\n\n'])).toEqual(
      [
        { type: 'message', data: 'a', lastEventId: '4' },
        { type: 'message', data: 'b', lastEventId: '4' },
        { type: 'message', data: 'c', lastEventId: '4' },
        { type: 'message', data: 'd', lastEventId: '' },
      ],
    );
    expect(parse(['event: snapshot\nid: 3\n\ndata: x\n\n'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '3' },
    ]);
    expect(parse(['data: complete\n\ndata: cut off at the end\n'])).toEqual([
      { type: 'message', data: 'complete', lastEventId: '' },
    ]);
  });

  it('decodes a UTF-8 sequence cut across chunks and removes a leading byte order mark', () => {
    const bytes = encoder.encode('data: 日本 ü 🚀\n\n');
    const cutInside = [bytes.subarray(0, 7), bytes.subarray(7, 18), bytes.subarray(18)];
    expect(parse(cutInside)).toEqual([{ type: 'message', data: '日本 ü 🚀', lastEventId: '' }]);
    expect(parse([Uint8Array.of(0xef, 0xbb), Uint8Array.of(0xbf), 'data: x\n\n'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '' },
    ]);
  });
});
