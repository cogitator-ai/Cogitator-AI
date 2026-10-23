import type { Stats } from 'node:fs';
import {
  link,
  lstat,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { WorkspaceError } from '@cogitator-ai/types';
import { getLogger } from '../logger';

/** Device and inode: what tells one file system entry from another. */
export interface Identity {
  dev: number;
  ino: number;
}

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

/** Prefix of the names a workspace gives entries while it moves them, see `stageInto`. */
export const STAGING_PREFIX = '.cogitator-place-';

export function kindOf(info: Stats): EntryKind {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

export function sameEntry(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

function existsError(path: string): Error {
  return Object.assign(new Error(`${path} exists`), { code: 'EEXIST' });
}

/**
 * Moves `from` to `to` without ever replacing an entry at `to`: a file is hard-linked (which
 * fails when `to` exists) and its old name removed, a symlink is created again, a directory is
 * renamed only when nothing is at `to` (a rename onto a directory replaces it only when it is
 * empty, so no content is lost in the instant between the check and the rename). Throws an error
 * with code `EEXIST` when `to` is taken.
 */
export async function placeNoReplace(from: string, to: string, kind: EntryKind): Promise<void> {
  if (kind === 'file') {
    try {
      await link(from, to);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error;
      if (await exists(to)) throw existsError(to);
      await rename(from, to);
      return;
    }
    await unlink(from);
    return;
  }
  if (kind === 'symlink') {
    await symlink(await readlink(from), to);
    await unlink(from);
    return;
  }
  if (await exists(to)) throw existsError(to);
  await rename(from, to);
}

/**
 * Moves `entry` (at a path only this process uses, in a holder of `.cogitator/pending/`) to
 * `target`, whose parent directory was verified inside the root with identity `parent`. The
 * entry first goes to a fresh random name in that directory, so the rename replaces nothing, and
 * the directory is checked to still be the verified one: when it was swapped for a symlink, the
 * entry is brought back from where it went and the move is refused. Only then does it get its
 * final name, without replacing anything (see {@link placeNoReplace}).
 */
export async function stageInto(
  entry: string,
  kind: EntryKind,
  target: string,
  parent: Identity,
  path: string
): Promise<void> {
  const dir = dirname(target);
  const staging = join(dir, `${STAGING_PREFIX}${nanoid(12)}`);
  await rename(entry, staging);
  const now = await realpath(dir).catch(() => undefined);
  const nowInfo = now ? await lstat(now).catch(() => undefined) : undefined;
  if (now !== dir || !nowInfo || !sameEntry(nowInfo, parent)) {
    if (now) await rename(join(now, basename(staging)), entry).catch(() => undefined);
    throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was being moved`, { path });
  }
  try {
    await placeNoReplace(staging, target, kind);
  } catch (error) {
    await rename(staging, entry).catch(() => undefined);
    if (errnoOf(error) === 'EEXIST') {
      throw new WorkspaceError('EXISTS', `${path} already exists`, { path, cause: error });
    }
    throw error;
  }
}

/** An entry moved into a holder of `.cogitator/pending/`, see {@link pinEntry}. */
export interface PinnedEntry {
  /** Where the entry is now */
  at: string;
  holder: string;
  kind: EntryKind;
  /** Where it came from, and the identity of that directory */
  from: string;
  fromParent: Identity;
}

/**
 * Moves the entry at `absolute` into `holder` (an empty directory just created under
 * `.cogitator/pending/`) and checks it is the one `before` describes. When a parent directory was
 * swapped for a symlink in between, the entry moved is another one: it is put back, without
 * replacing anything, into the directory outside the root the parent pointed to, and the
 * operation is refused. When that directory cannot be told (the symlink was swapped back), the
 * entry stays quarantined in the holder, logged, and nothing is deleted. `undefined` when the
 * entry is on another device than the holder, so it cannot be moved there.
 */
export async function pinEntry(
  absolute: string,
  before: Stats,
  holder: string,
  root: string,
  path: string
): Promise<PinnedEntry | undefined> {
  const fromParent = await lstat(dirname(absolute));
  const at = join(holder, nanoid(12));
  try {
    await rename(absolute, at);
  } catch (error) {
    if (errnoOf(error) === 'EXDEV') return undefined;
    throw error;
  }
  const moved = await lstat(at).catch(() => undefined);
  if (moved && sameEntry(moved, before)) {
    return { at, holder, kind: kindOf(moved), from: absolute, fromParent };
  }
  const now = await realpath(dirname(absolute)).catch(() => undefined);
  let returned = false;
  if (moved && now && !isWithin(root, now)) {
    returned = await placeNoReplace(at, join(now, basename(absolute)), kindOf(moved)).then(
      () => true,
      () => false
    );
  }
  if (returned) await rmdir(holder).catch(() => undefined);
  else {
    getLogger().warn('A workspace entry swapped in during a move is kept in quarantine', {
      path,
      quarantine: holder,
    });
  }
  throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was being resolved`, {
    path,
  });
}

/**
 * Puts a pinned entry back where it came from, without replacing anything. When that fails
 * (its directory was swapped or something new took its name), it stays in its holder, logged.
 */
export async function unpinEntry(pinned: PinnedEntry, path: string): Promise<void> {
  try {
    await stageInto(pinned.at, pinned.kind, pinned.from, pinned.fromParent, path);
    await rmdir(pinned.holder).catch(() => undefined);
  } catch {
    getLogger().warn('A workspace entry could not be put back and is kept in quarantine', {
      path,
      quarantine: pinned.holder,
    });
  }
}

/** Deletes a pinned entry (a directory with its contents only when `recursive`), then its holder. */
export async function deletePinned(pinned: PinnedEntry, recursive: boolean): Promise<void> {
  if (pinned.kind === 'directory') {
    if (recursive) await rm(pinned.at, { recursive: true, force: false });
    else await rmdir(pinned.at);
  } else {
    await unlink(pinned.at);
  }
  await rmdir(pinned.holder).catch(() => undefined);
}
