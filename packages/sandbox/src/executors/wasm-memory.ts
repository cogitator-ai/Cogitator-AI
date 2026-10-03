const MEMORY_SECTION = 5;
const HAS_MAXIMUM = 0x01;
const PREAMBLE_SIZE = 8;

interface Leb {
  value: bigint;
  next: number;
}

function readLeb(bytes: Uint8Array, offset: number): Leb {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  for (;;) {
    if (position >= bytes.length) throw new Error('Malformed WASM module: truncated LEB128');
    const byte = bytes[position++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: position };
    shift += 7n;
  }
}

function writeLeb(value: bigint): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0n);
  return out;
}

/**
 * The module with every memory it defines capped at `maxPages` (64 KiB
 * pages): a missing or larger maximum becomes `maxPages`, so `memory.grow`
 * past it fails inside the module whatever runtime executes it. Throws when
 * a memory needs more than `maxPages` to start. Imported memories belong to
 * the host and are left as they are.
 */
export function capModuleMemory(module: Uint8Array, maxPages: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`memoryPages must be a positive integer, got ${maxPages}`);
  }
  if (module.length < PREAMBLE_SIZE || module[0] !== 0x00 || module[1] !== 0x61) {
    throw new Error('Not a WASM module');
  }

  const limit = BigInt(maxPages);
  const parts: Uint8Array[] = [module.subarray(0, PREAMBLE_SIZE)];
  let offset = PREAMBLE_SIZE;

  while (offset < module.length) {
    const id = module[offset];
    const size = readLeb(module, offset + 1);
    const start = size.next;
    const end = start + Number(size.value);
    if (end > module.length) throw new Error('Malformed WASM module: section past the end');

    if (id !== MEMORY_SECTION) {
      parts.push(module.subarray(offset, end));
      offset = end;
      continue;
    }

    const count = readLeb(module, start);
    const content: number[] = writeLeb(count.value);
    let position = count.next;
    for (let i = 0n; i < count.value; i++) {
      const flags = module[position];
      const minimum = readLeb(module, position + 1);
      if (minimum.value > limit) {
        throw new Error(
          `WASM module needs ${minimum.value} memory pages to start; memoryPages allows ${maxPages}`
        );
      }
      let maximum = limit;
      position = minimum.next;
      if (flags & HAS_MAXIMUM) {
        const declared = readLeb(module, position);
        if (declared.value < maximum) maximum = declared.value;
        position = declared.next;
      }
      content.push(flags | HAS_MAXIMUM, ...writeLeb(minimum.value), ...writeLeb(maximum));
    }
    if (position !== end) throw new Error('Malformed WASM module: memory section size');

    parts.push(Uint8Array.from([id, ...writeLeb(BigInt(content.length)), ...content]));
    offset = end;
  }

  const capped = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    capped.set(part, cursor);
    cursor += part.length;
  }
  return capped;
}
