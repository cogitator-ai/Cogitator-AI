import { describe, it, expect } from 'vitest';
import { capModuleMemory } from '../executors/wasm-memory';

const PREAMBLE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

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

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

/** A module whose memory has these limits and that exports `grow(pages) -> previous size or -1`. */
function moduleWithMemory(minimum: number, maximum?: number): Uint8Array<ArrayBuffer> {
  const limits =
    maximum === undefined ? [0x00, ...uleb(minimum)] : [0x01, ...uleb(minimum), ...uleb(maximum)];
  const code = [0x00, 0x20, 0x00, 0x40, 0x00, 0x0b];
  return new Uint8Array([
    ...PREAMBLE,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...section(3, [1, 0]),
    ...section(5, [1, ...limits]),
    ...section(7, [1, 4, ...new TextEncoder().encode('grow'), 0x00, 0]),
    ...section(10, [1, ...uleb(code.length), ...code]),
  ]);
}

async function grow(module: Uint8Array<ArrayBuffer>, pages: number): Promise<number> {
  const instance = new WebAssembly.Instance(await WebAssembly.compile(module));
  const fn = instance.exports.grow;
  if (typeof fn !== 'function') throw new Error('grow is not exported');
  return (fn as (pages: number) => number)(pages);
}

describe('capModuleMemory', () => {
  it('gives a memory without a maximum the limit', async () => {
    const capped = capModuleMemory(moduleWithMemory(1), 4);

    expect(await grow(capped, 3)).toBe(1);
    expect(await grow(capped, 4)).toBe(-1);
    expect(await grow(moduleWithMemory(1), 4)).toBe(1);
  });

  it('lowers a larger maximum and keeps a smaller one', async () => {
    expect(await grow(capModuleMemory(moduleWithMemory(1, 100), 4), 4)).toBe(-1);
    expect(await grow(capModuleMemory(moduleWithMemory(1, 2), 4), 2)).toBe(-1);
    expect(await grow(capModuleMemory(moduleWithMemory(1, 2), 4), 1)).toBe(1);
  });

  it('refuses a module that needs more memory to start', () => {
    expect(() => capModuleMemory(moduleWithMemory(10), 4)).toThrow(
      'needs 10 memory pages to start; memoryPages allows 4'
    );
  });

  it('leaves a module without memory as it is', () => {
    const plain = new Uint8Array([...PREAMBLE, ...section(1, [0])]);

    expect(capModuleMemory(plain, 4)).toEqual(plain);
  });

  it('rejects bytes that are not a module and a non-positive limit', () => {
    expect(() => capModuleMemory(new Uint8Array([1, 2, 3]), 4)).toThrow('Not a WASM module');
    expect(() => capModuleMemory(moduleWithMemory(1), 0)).toThrow('positive integer');
  });
});
