/**
 * Unpacking a zip archive of a plugin without a dependency: stored and deflated entries, every
 * path checked to stay inside the target, links refused, size and entry limits
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** Most bytes the files of an archive may take unpacked */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/** Most entries an archive may hold */
export const MAX_ARCHIVE_ENTRIES = 20_000;

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

function broken(message: string): CogitatorError {
  return new CogitatorError({
    message: `The archive cannot be unpacked: ${message}`,
    code: ErrorCode.PLUGIN_INSTALL_FAILED,
  });
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  mode: number;
}

function entriesOf(archive: Buffer): Entry[] {
  const floor = Math.max(0, archive.length - 65_557);
  let end = -1;
  for (let at = archive.length - 22; at >= floor; at--) {
    if (archive.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) throw broken('it is not a zip file');
  const count = archive.readUInt16LE(end + 10);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw broken('ZIP64 archives are not supported');
  }
  if (count > MAX_ARCHIVE_ENTRIES)
    throw broken(`it holds more than ${MAX_ARCHIVE_ENTRIES} entries`);
  const entries: Entry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw broken('its central directory is damaged');
    }
    const flags = archive.readUInt16LE(at + 8);
    if ((flags & 0x1) !== 0) throw broken('it holds encrypted entries');
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const external = archive.readUInt32LE(at + 38);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.toString(
      (flags & 0x800) !== 0 ? 'utf8' : 'latin1',
      at + 46,
      at + 46 + nameLength
    );
    entries.push({ name, method, compressedSize, size, offset, mode: (external >>> 16) & 0xffff });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The path of `name` under the target, refusing one that leaves it */
function safePath(target: string, name: string): string {
  if (name.includes('\\') || name.includes('\0')) throw broken(`the entry ${name} has a bad name`);
  if (posix.isAbsolute(name) || /^[A-Za-z]:/.test(name))
    throw broken(`the entry ${name} is absolute`);
  const normal = posix.normalize(name);
  if (normal === '..' || normal.startsWith('../'))
    throw broken(`the entry ${name} leaves the folder`);
  const path = resolve(target, ...normal.split('/'));
  if (path !== target && !path.startsWith(`${target}${sep}`)) {
    throw broken(`the entry ${name} leaves the folder`);
  }
  return path;
}

/** Unpacks `archive` into `target` (created), returning the paths written, relative to it */
export async function unzip(archive: Buffer, target: string): Promise<string[]> {
  const root = resolve(target);
  await mkdir(root, { recursive: true });
  const written: string[] = [];
  let total = 0;
  for (const entry of entriesOf(archive)) {
    const kind = entry.mode & 0o170000;
    if (kind === 0o120000) throw broken(`the entry ${entry.name} is a symbolic link`);
    const path = safePath(root, entry.name);
    if (entry.name.endsWith('/')) {
      await mkdir(path, { recursive: true });
      continue;
    }
    total += entry.size;
    if (total > MAX_UNPACKED_BYTES)
      throw broken(`it unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
    const at = entry.offset;
    if (at + 30 > archive.length || archive.readUInt32LE(at) !== LOCAL_HEADER) {
      throw broken(`the entry ${entry.name} is damaged`);
    }
    const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
    const raw = archive.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        throw broken(`the entry ${entry.name} does not inflate`);
      }
    } else throw broken(`the entry ${entry.name} uses compression method ${entry.method}`);
    if (data.length !== entry.size) throw broken(`the entry ${entry.name} has the wrong size`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: (entry.mode & 0o111) !== 0 ? 0o755 : 0o644 });
    written.push(entry.name);
  }
  return written;
}

/** The folder of an unpacked plugin: the target itself, or its one folder when it holds only that */
export function archiveRootOf(target: string, written: readonly string[]): string {
  const tops = new Set(written.map((name) => name.split('/')[0] ?? ''));
  if (tops.size === 1) {
    const [only] = [...tops];
    if (only && written.every((name) => name.includes('/'))) return join(target, only);
  }
  return target;
}
