import { describe, it, expect } from 'vitest';
import { encodeNdjsonLine, readNdjson, type NdjsonLine } from '../index';

async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) yield part;
}

async function collect(
  source: AsyncIterable<string | Uint8Array>,
  maxLineBytes?: number
): Promise<NdjsonLine[]> {
  const lines: NdjsonLine[] = [];
  for await (const line of readNdjson(source, maxLineBytes === undefined ? {} : { maxLineBytes })) {
    lines.push(line);
  }
  return lines;
}

describe('encodeNdjsonLine', () => {
  it('writes one line of JSON', () => {
    expect(encodeNdjsonLine({ a: 'x\ny' })).toBe('{"a":"x\\ny"}\n');
  });

  it('refuses undefined', () => {
    expect(() => encodeNdjsonLine(undefined)).toThrow(TypeError);
  });
});

describe('readNdjson', () => {
  it('reads one value per line', async () => {
    expect(await collect(chunks('{"a":1}\n[2]\n"three"\n'))).toEqual([
      { value: { a: 1 } },
      { value: [2] },
      { value: 'three' },
    ]);
  });

  it('joins lines split across chunks', async () => {
    expect(await collect(chunks('{"a":', '1}\n{"b"', ':2}', '\n'))).toEqual([
      { value: { a: 1 } },
      { value: { b: 2 } },
    ]);
  });

  it('reads CRLF endings, skips blank lines and reads a last line without newline', async () => {
    expect(await collect(chunks('{"a":1}\r\n\r\n\n  \n{"b":2}'))).toEqual([
      { value: { a: 1 } },
      { value: { b: 2 } },
    ]);
  });

  it('decodes bytes, a character split across chunks included', async () => {
    const bytes = new TextEncoder().encode('{"word":"привет"}\n');
    const cut = 12;
    expect(await collect(chunks(bytes.slice(0, cut), bytes.slice(cut)))).toEqual([
      { value: { word: 'привет' } },
    ]);
  });

  it('reports invalid JSON and goes on with the next line', async () => {
    const lines = await collect(chunks('{"a":1}\nnot json\n{"b":2}\n'));
    expect(lines[0]).toEqual({ value: { a: 1 } });
    expect(lines[1]).toMatchObject({ error: { code: 'invalid_json', line: 2 } });
    expect(lines[2]).toEqual({ value: { b: 2 } });
  });

  it('skips a line over maxLineBytes and reads the next one', async () => {
    const long = `"${'x'.repeat(50)}"`;
    const lines = await collect(chunks(`${long}\n{"ok":true}\n`), 20);
    expect(lines).toEqual([
      { error: { code: 'line_too_long', message: 'Line is longer than 20 bytes', line: 1 } },
      { value: { ok: true } },
    ]);
  });

  it('skips a long line that arrives in many chunks without holding it', async () => {
    const pieces = Array.from({ length: 10 }, () => 'y'.repeat(10));
    const lines = await collect(chunks('"', ...pieces, '"\n', '1\n'), 32);
    expect(lines).toEqual([
      { error: expect.objectContaining({ code: 'line_too_long', line: 1 }) },
      { value: 1 },
    ]);
  });

  it('reports a long last line without newline', async () => {
    const lines = await collect(chunks('1\n', 'z'.repeat(40)), 16);
    expect(lines).toEqual([
      { value: 1 },
      { error: expect.objectContaining({ code: 'line_too_long', line: 2 }) },
    ]);
  });

  it('reads a line exactly at the limit', async () => {
    const value = `"${'a'.repeat(8)}"`;
    expect(await collect(chunks(`${value}\r\n`), value.length)).toEqual([{ value: 'aaaaaaaa' }]);
  });

  it('round-trips what encodeNdjsonLine writes', async () => {
    const values = [{ jsonrpc: '2.0', method: 'a', id: 1 }, 'text\nwith newline', 42];
    const text = values.map(encodeNdjsonLine).join('');
    expect(await collect(chunks(text))).toEqual(values.map((value) => ({ value })));
  });
});
