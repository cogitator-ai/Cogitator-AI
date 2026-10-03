const I64 = 0x7e;
const I32 = 0x7f;

function uleb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function name(value: string): number[] {
  const encoded = [...new TextEncoder().encode(value)];
  return [...uleb(encoded.length), ...encoded];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

function funcType(params: number[], results: number[]): number[] {
  return [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
}

function body(locals: number[][], code: number[]): number[] {
  const content = [...vector(locals), ...code];
  return [...uleb(content.length), ...content];
}

const INPUT_LENGTH = 0;
const INPUT_LOAD_U8 = 1;
const ALLOC = 2;
const STORE_U8 = 3;
const OUTPUT_SET = 4;

/**
 * Builds a minimal Extism plugin exporting `echo` (copies input to output),
 * `spin` (never returns), `fail` (returns a non-zero status) and `grow`
 * (grows its one-page memory by 1000 pages and traps when that is refused).
 * The module declares its memory without a maximum.
 */
export function buildExtismTestModule(): Uint8Array {
  const types = section(
    1,
    vector([
      funcType([], [I64]),
      funcType([I64], [I32]),
      funcType([I64], [I64]),
      funcType([I64, I32], []),
      funcType([I64, I64], []),
      funcType([], [I32]),
    ])
  );

  const imports = section(
    2,
    vector([
      [...name('extism:host/env'), ...name('input_length'), 0x00, 0],
      [...name('extism:host/env'), ...name('input_load_u8'), 0x00, 1],
      [...name('extism:host/env'), ...name('alloc'), 0x00, 2],
      [...name('extism:host/env'), ...name('store_u8'), 0x00, 3],
      [...name('extism:host/env'), ...name('output_set'), 0x00, 4],
    ])
  );

  const functions = section(3, vector([[5], [5], [5], [5]]));

  const memory = section(5, vector([[0x00, ...uleb(1)]]));

  const exports = section(
    7,
    vector([
      [...name('echo'), 0x00, 5],
      [...name('spin'), 0x00, 6],
      [...name('fail'), 0x00, 7],
      [...name('grow'), 0x00, 8],
    ])
  );

  const echo = body(
    [[3, I64]],
    [
      0x10,
      INPUT_LENGTH,
      0x21,
      0,
      0x20,
      0,
      0x10,
      ALLOC,
      0x21,
      1,
      0x42,
      0,
      0x21,
      2,
      0x02,
      0x40,
      0x03,
      0x40,
      0x20,
      2,
      0x20,
      0,
      0x5a,
      0x0d,
      1,
      0x20,
      1,
      0x20,
      2,
      0x7c,
      0x20,
      2,
      0x10,
      INPUT_LOAD_U8,
      0x10,
      STORE_U8,
      0x20,
      2,
      0x42,
      1,
      0x7c,
      0x21,
      2,
      0x0c,
      0,
      0x0b,
      0x0b,
      0x20,
      1,
      0x20,
      0,
      0x10,
      OUTPUT_SET,
      0x41,
      0,
      0x0b,
    ]
  );
  const spin = body([], [0x03, 0x40, 0x0c, 0, 0x0b, 0x41, 0, 0x0b]);
  const fail = body([], [0x41, 1, 0x0b]);
  const grow = body(
    [],
    [0x41, 0xe8, 0x07, 0x40, 0x00, 0x41, 0x7f, 0x46, 0x04, 0x40, 0x00, 0x0b, 0x41, 0, 0x0b]
  );

  const code = section(10, [...uleb(4), ...echo, ...spin, ...fail, ...grow]);

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...imports,
    ...functions,
    ...memory,
    ...exports,
    ...code,
  ]);
}
