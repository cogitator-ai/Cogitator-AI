/** The longest line {@link readNdjson} reads by default: 16 MiB */
export const DEFAULT_NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** A line of NDJSON as {@link readNdjson} reads it: its value, or why it could not be read */
export type NdjsonLine = { value: unknown } | { error: NdjsonLineError };

/** A line {@link readNdjson} could not read */
export interface NdjsonLineError {
  /** `invalid_json`: not one JSON value, `line_too_long`: over `maxLineBytes`, skipped */
  code: 'invalid_json' | 'line_too_long';
  message: string;
  /** Which line of the stream it was, from 1 */
  line: number;
}

export interface ReadNdjsonOptions {
  /** The longest line read, in UTF-8 bytes; a longer one is skipped with an error (default 16 MiB) */
  maxLineBytes?: number;
}

/** `value` as one line of NDJSON: its JSON and a newline */
export function encodeNdjsonLine(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('NDJSON cannot encode undefined');
  return `${json}\n`;
}

/**
 * Reads newline-delimited JSON from `source`, chunks of bytes or text split anywhere: one
 * `{ value }` per line, or `{ error }` for a line that is not one JSON value or is longer than
 * `maxLineBytes` (skipped without being held in memory), and reading goes on with the next line.
 * Lines may end with `\n` or `\r\n`, blank lines are skipped, and the last line needs no newline.
 * Bytes are read as UTF-8, a character split across chunks included.
 */
export async function* readNdjson(
  source: AsyncIterable<Uint8Array | string>,
  options: ReadNdjsonOptions = {}
): AsyncGenerator<NdjsonLine, void, undefined> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_NDJSON_MAX_LINE_BYTES;
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let pending = '';
  let pendingBytes = 0;
  let skipping = false;
  let line = 0;

  const tooLong = (): NdjsonLine => ({
    error: {
      code: 'line_too_long',
      message: `Line is longer than ${maxLineBytes} bytes`,
      line,
    },
  });

  function* take(text: string): Generator<NdjsonLine> {
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      line += 1;
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (skipping) {
        skipping = false;
        pending = '';
        pendingBytes = 0;
        yield tooLong();
        continue;
      }
      const whole = withoutCr(pending + piece);
      pending = '';
      pendingBytes = 0;
      if (encoder.encode(whole).byteLength > maxLineBytes) {
        yield tooLong();
        continue;
      }
      const read = readLine(whole, line);
      if (read) yield read;
    }
    const rest = text.slice(start);
    if (rest === '' || skipping) return;
    pending += rest;
    pendingBytes += encoder.encode(rest).byteLength;
    if (pendingBytes > maxLineBytes + 1) {
      skipping = true;
      pending = '';
      pendingBytes = 0;
    }
  }

  for await (const chunk of source) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* take(text);
  }
  yield* take(decoder.decode());
  if (skipping) {
    line += 1;
    yield tooLong();
  } else if (pending !== '') {
    line += 1;
    const last = withoutCr(pending);
    if (encoder.encode(last).byteLength > maxLineBytes) {
      yield tooLong();
    } else {
      const read = readLine(last, line);
      if (read) yield read;
    }
  }
}

function withoutCr(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** One line read, undefined for a blank one */
function readLine(text: string, line: number): NdjsonLine | undefined {
  if (text.trim() === '') return undefined;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      error: {
        code: 'invalid_json',
        message: error instanceof Error ? error.message : 'Invalid JSON',
        line,
      },
    };
  }
}
