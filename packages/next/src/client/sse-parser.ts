import type { StreamEvent } from '../streaming/protocol.js';

/** One event of a stream with the SSE id it was sent under, when the server sends ids */
export interface SSEFrame {
  event: StreamEvent;
  /**
   * The last event id the stream set, as `EventSource` keeps it: what a client sends back as
   * `Last-Event-ID` to resume after this event
   */
  id?: string;
}

type Parsed = { done: true } | { done: false; event?: StreamEvent };

function parseData(data: string): Parsed {
  if (data === '[DONE]') return { done: true };
  try {
    return { done: false, event: JSON.parse(data) as StreamEvent };
  } catch {
    console.warn('[cogitator] Failed to parse SSE data:', data);
    return { done: false };
  }
}

/**
 * The events of one SSE block. The data lines form one payload, as the SSE spec reads them,
 * when they do not, each line is read on its own, for servers that write one event per line
 * without a blank line between them.
 */
function blockEvents(dataLines: readonly string[]): Parsed[] {
  if (dataLines.length === 0) return [];
  const joined = dataLines.join('\n');
  if (dataLines.length > 1) {
    try {
      return [{ done: false, event: JSON.parse(joined) as StreamEvent }];
    } catch {
      return dataLines.map(parseData);
    }
  }
  return [parseData(joined)];
}

/** The name and value of an SSE field line: one space after the colon is dropped */
function field(line: string): { name: string; value: string } {
  const colon = line.indexOf(':');
  if (colon === -1) return { name: line, value: '' };
  const value = line.slice(colon + 1);
  return { name: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value };
}

/**
 * Reads the events of an SSE body as the SSE spec does: a blank line ends an event, comments
 * are skipped, `id:` sets the last event id that the events after it carry (a value with a NUL
 * is ignored), and the stream ends at `data: [DONE]`. An event the body ends in the middle of is
 * still read.
 */
export async function* parseSSEFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<SSEFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = function* (): Generator<SSEFrame, boolean> {
    const lines = dataLines;
    dataLines = [];
    for (const parsed of blockEvents(lines)) {
      if (parsed.done) return true;
      if (parsed.event) {
        yield lastEventId === undefined
          ? { event: parsed.event }
          : { event: parsed.event, id: lastEventId };
      }
    }
    return false;
  };

  const readLine = function* (raw: string): Generator<SSEFrame, boolean> {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') return yield* dispatch();
    if (line.startsWith(':')) return false;
    const { name, value } = field(line);
    if (name === 'data') dataLines.push(value);
    else if (name === 'id' && !value.includes('\0')) lastEventId = value || undefined;
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (yield* readLine(line)) return;
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    if (yield* readLine(line)) return;
  }
  yield* dispatch();
}

/** Reads the events of an SSE body, see {@link parseSSEFrames} */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamEvent> {
  for await (const frame of parseSSEFrames(reader)) yield frame.event;
}
