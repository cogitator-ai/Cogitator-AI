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
import { dirname, join, sep } from 'node:path';
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
 * Moves `entry` (at a path only this process uses, in a holder of `.cogitator/pending/`, with
 * identity `identity`) to `target`, whose parent directory was verified inside the root with
 * identity `parent`. The entry first goes to a fresh random name in that directory, so the rename
 * replaces nothing. Then both are checked: the directory must still be the verified one, and the
 * entry must be found under its random name. When the directory was swapped for a symlink and is
 * still swapped, the entry is moved back into its holder and checked by identity. When it was
 * swapped and swapped back already, the entry went outside the root under its random name and
 * cannot be found again: the error says so. Only once both checks pass does the entry get its
 * final name, without replacing anything (see {@link placeNoReplace}).
 */
export async function stageInto(
  entry: string,
  kind: EntryKind,
  identity: Identity,
  target: string,
  parent: Identity,
  path: string
): Promise<void> {
  const dir = dirname(target);
  const name = `${STAGING_PREFIX}${nanoid(12)}`;
  const staging = join(dir, name);
  await rename(entry, staging);
  const staged = await lstat(staging).catch(() => undefined);
  const now = await realpath(dir).catch(() => undefined);
  const nowInfo = now ? await lstat(now).catch(() => undefined) : undefined;
  const dirIntact = now === dir && nowInfo !== undefined && sameEntry(nowInfo, parent);
  const entryFound = staged !== undefined && sameEntry(staged, identity);
  if (!dirIntact || !entryFound) {
    if (entryFound) await bringBack(staging, entry, identity, path);
    throw new WorkspaceError(
      'OUTSIDE_ROOT',
      entryFound
        ? `${path} changed while it was being moved, the entry is back where it was`
        : `${path} changed while it was being moved: a concurrent change moved the entry out of the workspace as ${name}, it could not be found again`,
      { path }
    );
  }
  try {
    await placeNoReplace(staging, target, kind);
  } catch (error) {
    await bringBack(staging, entry, identity, path);
    if (errnoOf(error) === 'EEXIST') {
      throw new WorkspaceError('EXISTS', `${path} already exists`, { path, cause: error });
    }
    throw error;
  }
}

/** Moves an entry back from `from` to `to` (in its holder) and says honestly where it ended. */
async function bringBack(
  from: string,
  to: string,
  identity: Identity,
  path: string
): Promise<void> {
  await rename(from, to).catch(() => undefined);
  const back = await lstat(to).catch(() => undefined);
  if (back && sameEntry(back, identity)) return;
  getLogger().warn(
    back
      ? 'A workspace move brought back another entry than its own, which is kept in quarantine'
      : 'A workspace move lost track of an entry after a concurrent change',
    { path, ...(back ? { quarantine: to } : { lastSeen: from }) }
  );
}

/** An entry moved into a holder of `.cogitator/pending/`, see {@link pinEntry}. */
export interface PinnedEntry {
  /** Where the entry is now */
  at: string;
  holder: string;
  kind: EntryKind;
  identity: Identity;
  /** Where it came from, and the identity of that directory */
  from: string;
  fromParent: Identity;
}

/**
 * Moves the entry at `absolute` into `holder` (an empty directory just created under
 * `.cogitator/pending/`) and checks it is the one `before` describes. When a parent directory was
 * swapped for a symlink in between, the entry moved is another one, possibly from outside the
 * root: it is not moved again to a path that would have to be resolved anew (which the same
 * concurrent change could steer), but kept quarantined in the holder, and the error names it.
 * Processes that can read the root can read the quarantine too. `undefined` when the entry is
 * on another device than the holder, so it cannot be moved there.
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
    return {
      at,
      holder,
      kind: kindOf(moved),
      identity: moved,
      from: absolute,
      fromParent,
    };
  }
  const quarantine = toPosixRelative(root, at);
  getLogger().warn('An entry swapped in during a workspace move is kept in quarantine', {
    path,
    quarantine,
  });
  throw new WorkspaceError(
    'OUTSIDE_ROOT',
    `${path} changed while it was being resolved: the entry moved instead is kept in ${quarantine}`,
    { path }
  );
}

/**
 * Puts a pinned entry back where it came from, without replacing anything. When that fails
 * (its directory was swapped or something new took its name), it stays in its holder, logged.
 * An entry no longer in its holder (a failed move already reported where it went) is left alone.
 */
export async function unpinEntry(pinned: PinnedEntry, path: string): Promise<void> {
  const here = await lstat(pinned.at).catch(() => undefined);
  if (!here || !sameEntry(here, pinned.identity)) return;
  try {
    await stageInto(pinned.at, pinned.kind, pinned.identity, pinned.from, pinned.fromParent, path);
    await rmdir(pinned.holder).catch(() => undefined);
  } catch (error) {
    const still = await lstat(pinned.at).catch(() => undefined);
    if (still && sameEntry(still, pinned.identity)) {
      getLogger().warn('A workspace entry could not be put back and is kept in quarantine', {
        path,
        quarantine: pinned.at,
      });
    } else {
      getLogger().warn('A workspace entry could not be put back', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toPosixRelative(root: string, path: string): string {
  return path
    .slice(root.length + 1)
    .split(sep)
    .join('/');
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
