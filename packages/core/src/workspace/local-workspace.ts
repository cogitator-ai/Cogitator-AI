import { constants, type Stats } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import {
  WorkspaceError,
  workspaceGlobMatcher,
  type Workspace,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceListOptions,
  type WorkspaceReadOptions,
  type WorkspaceRemoveOptions,
  type WorkspaceRemoveResult,
  type WorkspaceRenameOptions,
  type WorkspaceRestoreOptions,
  type WorkspaceRestoreResult,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
  type WorkspaceStat,
  type WorkspaceWriteOptions,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { trimTrailingSlashes } from '../utils/url';
import {
  deletePinned,
  pinEntry,
  STAGING_PREFIX,
  stageInto,
  unpinEntry,
  type PinnedEntry,
} from './placement';
import { abortError, ProcessGroups, runProcess, type WorkspaceLaunch } from './process';
import {
  SnapshotStore,
  type SnapshotGcReport,
  type SnapshotRestoreOps,
  type SnapshotRetention,
} from './snapshot-store';

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE = 2_000;
const MAX_SYMLINK_HOPS = 40;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/** The directory inside the root a workspace keeps its own files in, ignored by git. */
export const WORKSPACE_SERVICE_DIR = '.cogitator';
/** Where `remove({ trash: true })` moves entries, relative to the root. */
export const WORKSPACE_TRASH_DIR = `${WORKSPACE_SERVICE_DIR}/trash`;
const PENDING_DIR = `${WORKSPACE_SERVICE_DIR}/pending`;
const TEMP_PREFIX = '.cogitator-tmp-';
const LEFTOVER_AGE = 60 * 60 * 1000;
const SWEEP_MAX_DIRS = 5_000;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

/**
 * Environment variables a command inherits from the process by default: what a shell needs to
 * find programs and format text, and nothing that may hold a secret. `HOME` is among them, so
 * a command can still read what your home directory holds (`~/.ssh`, `~/.aws`).
 */
export const WORKSPACE_INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
] as const;

export interface LocalWorkspaceOptions {
  /** The directory the workspace is confined to */
  root: string;
  /** Id of the workspace (default: generated) */
  id?: string;
  /** The current directory, relative to the root (default: `.`) */
  cwd?: string;
  /** Create the root when it is missing (default: true) */
  create?: boolean;
  /** Largest file `read` and `write` accept, in bytes (default: 10 MiB) */
  maxFileBytes?: number;
  /**
   * Refuse to read a file with more than one hard link (code `DENIED`), since a hard link in the
   * root may be a file outside it. Off by default: package managers (pnpm) hard-link
   * `node_modules` files to their store, which this would make unreadable. Writes replace the
   * file, so they never reach the other links either way
   */
  refuseHardLinks?: boolean;
  /**
   * Milliseconds a leftover of an interrupted write or move must have been untouched (by its
   * inode change time) before starting the workspace cleans it up (default: one hour)
   */
  leftoverAge?: number;
  exec?: LocalWorkspaceExecConfig;
  /** How `snapshot()` records the files and how long snapshots are kept */
  snapshots?: LocalWorkspaceSnapshotConfig;
}

/** How a `LocalWorkspace` keeps its snapshots, see `LocalWorkspace.snapshot()` */
export interface LocalWorkspaceSnapshotConfig {
  /** Globs every snapshot leaves out, on top of the defaults and a call's own `exclude` */
  exclude?: readonly string[];
  /** Files larger than this many bytes are skipped unless a call says otherwise (default: 10 MiB) */
  maxFileBytes?: number;
  /**
   * Which snapshots are kept: after each new one, the snapshots beyond `count` (oldest first)
   * and those older than `maxAgeMs` are deleted, with the contents only they used. Default: all
   * kept, delete them with `deleteSnapshot()` or `pruneSnapshots()`
   */
  retain?: SnapshotRetention;
  /**
   * Milliseconds a stored content that no snapshot uses is kept before a collection deletes it
   * (default: one hour), so a snapshot another process is taking keeps what it stored already
   */
  gcGraceMs?: number;
}

export interface LocalWorkspaceExecConfig {
  /**
   * The POSIX shell commands run with, as `<shell> -c <command>` (default: `/bin/sh`). On Windows
   * commands run with `cmd.exe /d /s /c` unless a shell is given
   */
  shell?: string;
  /** Environment variables every command gets */
  env?: Record<string, string>;
  /**
   * What commands inherit from this process's environment: `true` for all of it, a list of
   * names, or the default {@link WORKSPACE_INHERITED_ENV}, which leaves API keys out
   */
  inheritEnv?: boolean | readonly string[];
  /** Milliseconds before a command is killed (default: 120000) */
  timeout?: number;
  /** Bytes of stdout and of stderr a result keeps (default: 1 MiB each) */
  maxOutputBytes?: number;
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped (default: 2000) */
  killGrace?: number;
  /**
   * What happens to processes a command started in the background (`&`) once it exits, when the
   * call does not say (`WorkspaceExecOptions.background`): `kill` (default) or `keep` until
   * `dispose()`
   */
  background?: 'kill' | 'keep';
  /**
   * Changes what is spawned for a command, e.g. to run it under an OS sandbox (`sandbox-exec`,
   * `bwrap`): it gets the program, arguments, directory and environment the workspace would use
   * and returns the program and arguments to spawn instead. The process group, its kill on a
   * timeout or an abort, the trimmed environment and the output caps stay
   */
  launch?: (launch: WorkspaceLaunch) => Pick<WorkspaceLaunch, 'file' | 'args'>;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

/** What a workspace and its `withCwd()` views share. */
interface LocalWorkspaceState {
  realRoot?: string;
  starting?: Promise<string>;
  sweeping?: Promise<void>;
  disposed: boolean;
  groups: ProcessGroups;
  /** The snapshot store of the root, taken on first use and let go in `dispose()` */
  store?: SnapshotStore;
  /** Restores changing the files now: commands are refused meanwhile */
  restoring: number;
}

/**
 * A workspace in a directory of this machine.
 *
 * File operations never leave the root: a path is resolved with every symlink followed (a
 * dangling one too) and refused when it lands outside. Only regular files are read or written
 * (a FIFO or a device is refused before it is opened), files are opened with `O_NOFOLLOW` and
 * checked again once open, so a symlink swapped in between the check and the open is caught.
 * Writes go to a temporary file in the same directory, renamed over the target: a crash never
 * leaves half a file, and a hard link to a file outside the root is replaced, not written
 * through. `remove` and `rename` first move the entry into the workspace's own directory and
 * check it is the entry they resolved, so a parent directory swapped for a symlink in between
 * cannot make them delete or move what lies outside the root.
 *
 * What it does not stop: reading a hard link to a file outside the root (see
 * `refuseHardLinks`), a race that swaps a parent directory for a symlink right before `mkdir`
 * creating an empty directory outside the root, and `exec`, which runs as this process with only
 * its directory confined. Use `DockerWorkspace` from `@cogitator-ai/sandbox` for commands you do
 * not trust.
 *
 * Snapshots are kept content-addressed in `.cogitator/checkpoints` (see `snapshot()`), cheap
 * enough to take one before every user message: a file that did not change since the snapshot
 * before is not read again, and a content or a directory that did not change is stored once.
 *
 * The workspace starts itself on first use, `start()` only makes errors (a missing root with
 * `create: false`) surface early. `dispose()` kills the commands still running and what they
 * left running in the background.
 *
 * @example
 * ```ts
 * const workspace = new LocalWorkspace({ root: './project' });
 * const agent = new Agent({ name: 'coder', instructions: '...', tools: workspaceTools(), workspace });
 * await cog.run(agent, { input: 'Add a test for the parser' });
 * await workspace.dispose();
 * ```
 */
export class LocalWorkspace implements Workspace {
  readonly id: string;
  readonly cwd: string;
  private readonly givenRoot: string;
  private readonly create: boolean;
  private readonly maxFileBytes: number;
  private readonly refuseHardLinks: boolean;
  private readonly leftoverAge: number;
  private readonly execConfig: LocalWorkspaceExecConfig;
  private readonly snapshotConfig: LocalWorkspaceSnapshotConfig;
  private readonly state: LocalWorkspaceState;

  constructor(options: LocalWorkspaceOptions) {
    if (!options.root) throw new WorkspaceError('INVALID_PATH', 'A workspace needs a root');
    this.givenRoot = resolve(options.root);
    this.id = options.id ?? `workspace_${nanoid(10)}`;
    this.cwd = normalizeCwd(options.cwd);
    this.create = options.create ?? true;
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
    this.refuseHardLinks = options.refuseHardLinks ?? false;
    this.leftoverAge = options.leftoverAge ?? LEFTOVER_AGE;
    if (!(this.leftoverAge >= 0))
      throw new RangeError('leftoverAge must be 0 or more milliseconds');
    this.execConfig = options.exec ?? {};
    this.snapshotConfig = options.snapshots ?? {};
    positive(this.snapshotConfig.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'snapshots.maxFileBytes');
    if (this.snapshotConfig.gcGraceMs !== undefined && !(this.snapshotConfig.gcGraceMs >= 0)) {
      throw new RangeError('snapshots.gcGraceMs must be 0 or more milliseconds');
    }
    positive(this.execConfig.timeout, DEFAULT_EXEC_TIMEOUT, 'exec.timeout');
    positive(this.execConfig.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'exec.maxOutputBytes');
    positive(this.execConfig.killGrace, DEFAULT_KILL_GRACE, 'exec.killGrace');
    this.state = { disposed: false, groups: new ProcessGroups(), restoring: 0 };
  }

  /**
   * A new workspace over `root` with everything else of this one: its file limits, hard-link
   * rule, cleanup age and command settings (shell, environment, timeouts, `launch` sandbox).
   * It has an id and a lifecycle of its own, its current directory is `cwd` (default this one's)
   */
  withRoot(root: string, cwd: string = this.cwd): LocalWorkspace {
    return new LocalWorkspace({
      root,
      cwd,
      create: this.create,
      maxFileBytes: this.maxFileBytes,
      refuseHardLinks: this.refuseHardLinks,
      leftoverAge: this.leftoverAge,
      exec: this.execConfig,
      snapshots: this.snapshotConfig,
    });
  }

  /** The root with symlinks resolved once started, the given root before */
  get root(): string {
    return this.state.realRoot ?? this.givenRoot;
  }

  /**
   * Opens the workspace and waits for the cleanup of what interrupted writes and moves left
   * behind. A workspace started by its first operation runs that cleanup in the background
   */
  async start(): Promise<void> {
    await this.ready();
    await this.state.sweeping;
  }

  async dispose(): Promise<void> {
    this.state.disposed = true;
    this.state.groups.killAll();
    if (this.state.store) {
      SnapshotStore.release(this.state.store);
      this.state.store = undefined;
    }
  }

  withCwd(cwd: string): LocalWorkspace {
    const view: LocalWorkspace = Object.create(LocalWorkspace.prototype);
    return Object.assign(view, this, { cwd: normalizeCwd(cwd) });
  }

  async contains(path: string): Promise<boolean> {
    try {
      await this.locate(path, true);
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string, options: WorkspaceReadOptions = {}): Promise<string> {
    const bytes = await this.readBytes(path, options);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  }

  async readBytes(path: string, options: WorkspaceReadOptions = {}): Promise<Uint8Array> {
    const limit = positive(options.maxBytes, this.maxFileBytes, 'maxBytes');
    const { absolute } = await this.locate(path, true);
    const before = await this.lstatOf(absolute, path);
    if (!before.isFile()) throw notAFile(path, before);
    if (before.size > limit) throw tooLarge(path, before.size, limit);
    const handle = await this.openVerified(absolute, constants.O_RDONLY, path);
    try {
      const info = await handle.stat();
      if (!info.isFile() || !sameFile(info, before)) {
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was opened`, { path });
      }
      if (this.refuseHardLinks && info.nlink > 1) {
        throw new WorkspaceError(
          'DENIED',
          `${path} has ${info.nlink} hard links, and hard-linked files are refused`,
          { path }
        );
      }
      return await readAtMost(handle, limit, path);
    } finally {
      await handle.close();
    }
  }

  async write(
    path: string,
    content: string | Uint8Array,
    options: WorkspaceWriteOptions = {}
  ): Promise<void> {
    const limit = positive(options.maxBytes, this.maxFileBytes, 'maxBytes');
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (bytes.byteLength > limit) throw tooLarge(path, bytes.byteLength, limit);
    const { absolute, relative: rel } = await this.locate(path, true);
    if (rel === '.') throw new WorkspaceError('NOT_A_FILE', 'The root is not a file', { path });
    this.refuseInternal(rel, path);
    if (options.createParents ?? true) await this.mkdirAt(dirname(absolute), path);
    if (rel === WORKSPACE_SERVICE_DIR || rel.startsWith(`${WORKSPACE_SERVICE_DIR}/`)) {
      await this.ensureServiceDir();
    }

    const existing = await lstat(absolute).catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT') return undefined;
      throw ioError(error, path);
    });
    if (existing && !existing.isFile()) throw notAFile(path, existing);
    if (existing && !options.force) {
      await access(absolute, constants.W_OK).catch((error: unknown) => {
        throw new WorkspaceError('DENIED', `${path} is read-only, pass force to replace it`, {
          path,
          cause: error,
        });
      });
    }

    const temp = join(dirname(absolute), `${TEMP_PREFIX}${nanoid(12)}`);
    const handle = await this.openVerified(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      path
    );
    let renamed = false;
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          written
        );
        written += bytesWritten;
      }
      if (existing) await handle.chmod(existing.mode & 0o7777);
      await handle.sync();
      await handle.close();
      await this.verifyParent(absolute, path);
      await rename(temp, absolute).catch((error: unknown) => {
        throw ioError(error, path);
      });
      renamed = true;
      await syncDirectory(dirname(absolute));
    } finally {
      if (!renamed) {
        await handle.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
      }
    }
  }

  async list(path = '.', options: WorkspaceListOptions = {}): Promise<WorkspaceEntry[]> {
    const { absolute } = await this.locate(path, true);
    const info = await this.lstatOf(absolute, path);
    if (!info.isDirectory()) {
      throw new WorkspaceError('NOT_A_DIRECTORY', `${path} is not a directory`, { path });
    }
    const matches = options.glob ? workspaceGlobMatcher(options.glob) : undefined;
    const skip = new Set(options.skipDirs ?? []);
    const limit = options.limit ?? Infinity;
    const entries: WorkspaceEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      const real = await realpath(dir);
      if (!isWithin(this.root, real)) return;
      const names = (await readdir(real, { withFileTypes: true }))
        .map((dirent) => dirent.name)
        .sort();
      for (const name of names) {
        if (entries.length >= limit) return;
        if (!options.includeHidden && name.startsWith('.')) continue;
        const full = join(real, name);
        let entryInfo: Stats;
        try {
          entryInfo = await lstat(full);
        } catch {
          continue;
        }
        const type = entryType(entryInfo);
        const relToList = toPosix(relative(absolute, full));
        if (!matches || matches(relToList)) {
          entries.push({
            name,
            path: this.relativeOf(full),
            type,
            size: entryInfo.size,
            modifiedAt: entryInfo.mtimeMs,
          });
        }
        if (options.recursive && type === 'directory' && !skip.has(name)) await walk(full);
      }
    };

    await walk(absolute);
    return entries;
  }

  async stat(path: string): Promise<WorkspaceStat> {
    const { absolute, relative: rel } = await this.locate(path, true);
    const info = await this.lstatOf(absolute, path);
    return { path: rel, type: entryType(info), size: info.size, modifiedAt: info.mtimeMs };
  }

  async exists(path: string): Promise<boolean> {
    const { absolute } = await this.locate(path, true);
    try {
      await lstat(absolute);
      return true;
    } catch (error) {
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return false;
      throw ioError(error, path);
    }
  }

  async mkdir(path: string): Promise<void> {
    const { absolute } = await this.locate(path, true);
    await this.mkdirAt(absolute, path);
  }

  async remove(path: string, options: WorkspaceRemoveOptions = {}): Promise<WorkspaceRemoveResult> {
    const { absolute, relative: rel } = await this.locate(path, false);
    this.refuseWhileBusy(path);
    if (rel === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be removed', { path });
    }
    this.refuseInternal(rel, path);
    const info = await this.lstatOf(absolute, path);
    if (info.isDirectory() && !options.recursive && (await readdir(absolute)).length > 0) {
      throw new WorkspaceError(
        'NOT_EMPTY',
        `${path} is a directory with entries, pass recursive to remove it`,
        { path }
      );
    }
    const recursive = options.recursive ?? false;

    if (options.trash) {
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${nanoid(6)}`;
      const trashedTo = `${WORKSPACE_TRASH_DIR}/${stamp}/${rel}`;
      const target = join(this.root, ...trashedTo.split('/'));
      await this.ensureServiceDir();
      await this.mkdirAt(dirname(target), path);
      const targetParent = await this.lstatOf(dirname(target), path);
      const pinned = await this.pinOrNull(absolute, info, path);
      if (!pinned) {
        throw new WorkspaceError('UNSUPPORTED', `${path} is on another device than the trash`, {
          path,
        });
      }
      try {
        await stageInto(pinned.at, pinned.kind, pinned.identity, target, targetParent, path);
      } catch (error) {
        await unpinEntry(pinned, path);
        throw ioError(error, path);
      }
      await rmdir(pinned.holder).catch(() => undefined);
      return { path: rel, trashedTo };
    }

    const pinned = await this.pinOrNull(absolute, info, path);
    if (!pinned) {
      await this.removeInPlace(absolute, info, recursive, path);
      return { path: rel };
    }
    try {
      await deletePinned(pinned, recursive);
    } catch (error) {
      await unpinEntry(pinned, path);
      throw ioError(error, path);
    }
    return { path: rel };
  }

  async rename(from: string, to: string, options: WorkspaceRenameOptions = {}): Promise<void> {
    const source = await this.locate(from, false);
    const target = await this.locate(to, false);
    this.refuseWhileBusy(from);
    if (source.relative === '.' || target.relative === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be moved', { path: from });
    }
    this.refuseInternal(source.relative, from);
    this.refuseInternal(target.relative, to);
    if (target.relative === source.relative) return;
    if (target.relative.startsWith(`${source.relative}/`)) {
      throw new WorkspaceError('INVALID_PATH', `${to} is inside ${from}`, { path: to });
    }
    const info = await this.lstatOf(source.absolute, from);
    const existing = await lstat(target.absolute).catch(() => undefined);
    if (existing) {
      if (!options.overwrite) {
        throw new WorkspaceError('EXISTS', `${to} already exists`, { path: to });
      }
      if (existing.isDirectory() && !info.isDirectory()) {
        throw new WorkspaceError('NOT_A_FILE', `${to} is a directory`, { path: to });
      }
      if (!existing.isDirectory() && info.isDirectory()) {
        throw new WorkspaceError('NOT_A_DIRECTORY', `${to} is not a directory`, { path: to });
      }
      if (existing.isDirectory() && (await readdir(target.absolute)).length > 0) {
        throw new WorkspaceError('NOT_EMPTY', `${to} is a directory with entries`, { path: to });
      }
    }
    await this.mkdirAt(dirname(target.absolute), to);
    const targetParent = await this.lstatOf(dirname(target.absolute), to);

    const replaced = existing ? await this.pinOrNull(target.absolute, existing, to) : undefined;
    if (existing && !replaced) {
      throw new WorkspaceError('UNSUPPORTED', `${to} is on another device`, { path: to });
    }
    const pinned = await this.pinOrNull(source.absolute, info, from).catch(
      async (error: unknown) => {
        if (replaced) await unpinEntry(replaced, to);
        throw error;
      }
    );
    if (!pinned) {
      if (replaced) await unpinEntry(replaced, to);
      throw new WorkspaceError(
        'UNSUPPORTED',
        `${from} is on another device than the workspace's own directory, move it with a command`,
        { path: from }
      );
    }
    try {
      await stageInto(pinned.at, pinned.kind, pinned.identity, target.absolute, targetParent, to);
    } catch (error) {
      await unpinEntry(pinned, from);
      if (replaced) await unpinEntry(replaced, to);
      throw ioError(error, to);
    }
    if (replaced) await deletePinned(replaced, false).catch(() => undefined);
    await rmdir(pinned.holder).catch(() => undefined);
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    const timeout = positive(
      options.timeout,
      this.execConfig.timeout ?? DEFAULT_EXEC_TIMEOUT,
      'timeout'
    );
    const maxOutput = positive(
      options.maxOutputBytes,
      this.execConfig.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes'
    );
    const cwdPath = options.cwd ?? this.cwd;
    const { absolute: cwd } = await this.locate(cwdPath, true);
    const cwdInfo = await this.lstatOf(cwd, cwdPath);
    if (!cwdInfo.isDirectory()) {
      throw new WorkspaceError('NOT_A_DIRECTORY', `${cwdPath} is not a directory`, {
        path: cwdPath,
      });
    }
    if (options.signal?.aborted) throw abortError(options.signal);

    const env = { ...this.inheritedEnv(), ...this.execConfig.env, ...options.env };
    const planned = this.shellLaunch(command, cwd, env);
    const launch = this.execConfig.launch
      ? { ...planned, ...this.execConfig.launch(planned) }
      : planned;
    if (this.state.restoring > 0) {
      throw new WorkspaceError(
        'BUSY',
        'A snapshot is being restored in the workspace: run the command once it is done',
        { path: cwdPath }
      );
    }
    this.state.groups.prune();
    return runProcess({
      launch,
      timeout,
      maxOutput,
      killGrace: this.execConfig.killGrace ?? DEFAULT_KILL_GRACE,
      background: options.background ?? this.execConfig.background ?? 'kill',
      groups: this.state.groups,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  /**
   * Records the files of the root in `.cogitator/checkpoints`, but for what the default excludes
   * (`.cogitator`, `node_modules` and `.git` at any depth), `snapshots.exclude` and `exclude`
   * leave out. A file is kept by its sha256, read only when its size, times, inode or mode
   * changed since the snapshot before, and its content is stored once however many snapshots
   * hold it. A symlink is recorded as a link, never followed, a directory with its mode, and a
   * file over `maxFileBytes` is skipped (listed in `skipped`, logged), as is a file with more
   * than one hard link when the workspace refuses to read those (`refuseHardLinks`). `stats` says what the
   * snapshot read and stored. With `snapshots.retain`, older snapshots go after it
   */
  async snapshot(options: WorkspaceSnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const store = await this.snapshotStore();
    const snapshot = await store.take({
      workspaceId: this.id,
      refuseHardLinks: this.refuseHardLinks,
      ...(options.label !== undefined && { label: options.label }),
      ...(options.metadata !== undefined && { metadata: options.metadata }),
      exclude: [...(this.snapshotConfig.exclude ?? []), ...(options.exclude ?? [])],
      maxFileBytes: positive(
        options.maxFileBytes,
        this.snapshotConfig.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        'maxFileBytes'
      ),
    });
    const large = (snapshot.skipped ?? []).filter((skip) => skip.reason === 'too-large');
    if (large.length > 0) {
      getLogger().warn('A workspace snapshot skipped files over its size limit', {
        workspace: this.id,
        snapshot: snapshot.id,
        files: large.slice(0, 10).map((skip) => skip.path),
        ...(large.length > 10 && { more: large.length - 10 }),
      });
    }
    if (this.snapshotConfig.retain) {
      await this.pruneSnapshots(this.snapshotConfig.retain, [
        snapshot.id,
        ...(options.protect ?? []),
      ]).catch((error: unknown) => {
        getLogger().warn('Old workspace snapshots could not be pruned, the new one is kept', {
          workspace: this.id,
          snapshot: snapshot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return snapshot;
  }

  /**
   * Brings the files back to a snapshot through the workspace's own safe placement: a changed
   * file is written again atomically with its mode, a symlink made again, a missing directory
   * created, and what the snapshot did not have removed (a directory only once empty). Paths the
   * snapshot excluded or skipped are never touched, and a directory made since that holds such a
   * path stays. Unchanged files are told by their times, or by their content when those moved.
   * Present files the snapshot could not have kept (over its size limit, unreadable), special
   * files and directories that cannot be read are left alone too (`kept`). With `dryRun`
   * nothing changes, and `busy` says whether a restore would be refused now. Refused with `BUSY`
   * while a command the workspace started still runs, which could race the changes, and a
   * command asked for while a restore changes the files is refused with `BUSY` too
   */
  async restore(
    snapshotId: string,
    options: WorkspaceRestoreOptions = {}
  ): Promise<WorkspaceRestoreResult> {
    const store = await this.snapshotStore();
    const dryRun = options.dryRun ?? false;
    const busy = this.state.groups.busy();
    if (!dryRun && busy) {
      throw new WorkspaceError(
        'BUSY',
        'The workspace cannot be restored while a command started in it is still running (or left processes in the background): wait for it or dispose the workspace',
        { path: snapshotId }
      );
    }
    if (dryRun) {
      const result = await store.restore(snapshotId, this.restoreOps(), true, {
        refuseHardLinks: this.refuseHardLinks,
      });
      return { ...result, busy };
    }
    this.state.restoring++;
    try {
      return await store.restore(snapshotId, this.restoreOps(), false, {
        refuseHardLinks: this.refuseHardLinks,
      });
    } finally {
      this.state.restoring--;
    }
  }

  async listSnapshots(): Promise<WorkspaceSnapshot[]> {
    return (await this.snapshotStore()).list();
  }

  /** Forgets a snapshot, then deletes the contents no other snapshot uses (see `gcGraceMs`) */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await (await this.snapshotStore()).delete(snapshotId, this.gcGrace());
  }

  /**
   * Deletes the snapshots `retention` (default `snapshots.retain`, else none) does not keep,
   * never one of `protect`, then collects the contents no snapshot uses: a mark over every manifest, a sweep of the rest
   */
  async pruneSnapshots(
    retention: SnapshotRetention = this.snapshotConfig.retain ?? {},
    protect: readonly string[] = []
  ): Promise<{ deleted: string[]; gc: SnapshotGcReport }> {
    return (await this.snapshotStore()).prune(retention, this.gcGrace(), protect);
  }

  /**
   * Copies a snapshot with every content it uses into the snapshots of `target`, a
   * `LocalWorkspace` or a workspace over one (`DockerWorkspace`), so `target.restore()` brings
   * its files back there, under the same id
   */
  async copySnapshot(snapshotId: string, target: Workspace): Promise<WorkspaceSnapshot> {
    const local = localOf(target);
    if (!local) {
      throw new WorkspaceError(
        'UNSUPPORTED',
        `A snapshot of a LocalWorkspace can be copied into another LocalWorkspace (or a workspace over one), not into ${target.id}`,
        { path: snapshotId }
      );
    }
    const from = await this.snapshotStore();
    return from.copyTo(snapshotId, await local.snapshotStore());
  }

  /** The snapshot store of the root, taken once per workspace, with `.cogitator` made first */
  private async snapshotStore(): Promise<SnapshotStore> {
    const root = await this.ready();
    await this.ensureServiceDir();
    this.state.store ??= SnapshotStore.acquire(root);
    return this.state.store;
  }

  private gcGrace(): number {
    return this.snapshotConfig.gcGraceMs ?? LEFTOVER_AGE;
  }

  /** How a restore writes: every path resolved inside the root, nothing followed out of it */
  private restoreOps(): SnapshotRestoreOps {
    return {
      writeFile: (path, bytes, mode) => this.replaceFile(path, bytes, mode),
      symlink: (path, target) => this.replaceWithSymlink(path, target),
      mkdir: async (path) => {
        const { absolute } = await this.locate(path, false);
        await this.mkdirAt(absolute, path);
      },
      remove: async (path, recursive) => {
        await this.remove(path, { recursive });
      },
      chmod: (path, mode) => this.chmodAt(path, mode),
    };
  }

  /** Writes a file with `mode` through a temporary file renamed over what is at `path`, a symlink included */
  private async replaceFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const { absolute, relative: rel } = await this.locate(path, false);
    if (rel === '.') throw new WorkspaceError('NOT_A_FILE', 'The root is not a file', { path });
    this.refuseInternal(rel, path);
    await this.mkdirAt(dirname(absolute), path);
    const temp = join(dirname(absolute), `${TEMP_PREFIX}${nanoid(12)}`);
    const handle = await this.openVerified(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      path
    );
    let renamed = false;
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          written
        );
        written += bytesWritten;
      }
      await handle.chmod(mode & 0o7777);
      await handle.sync();
      await handle.close();
      await this.verifyParent(absolute, path);
      await rename(temp, absolute).catch((error: unknown) => {
        throw ioError(error, path);
      });
      renamed = true;
      await syncDirectory(dirname(absolute));
    } finally {
      if (!renamed) {
        await handle.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
      }
    }
  }

  /** Makes a symlink to `target` at a temporary name and renames it over what is at `path` */
  private async replaceWithSymlink(path: string, target: string): Promise<void> {
    const { absolute, relative: rel } = await this.locate(path, false);
    if (rel === '.') throw new WorkspaceError('NOT_A_FILE', 'The root is not a symlink', { path });
    this.refuseInternal(rel, path);
    await this.mkdirAt(dirname(absolute), path);
    const temp = join(dirname(absolute), `${TEMP_PREFIX}${nanoid(12)}`);
    await symlink(target, temp).catch((error: unknown) => {
      throw ioError(error, path);
    });
    try {
      await this.verifyParent(absolute, path);
      await rename(temp, absolute);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw ioError(error, path);
    }
  }

  /** Changes the mode of a file or a directory, opened without following a symlink */
  private async chmodAt(path: string, mode: number): Promise<void> {
    const { absolute } = await this.locate(path, false);
    const info = await this.lstatOf(absolute, path);
    if (info.isSymbolicLink()) return;
    const flags = info.isDirectory()
      ? constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW
      : constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
    const handle = await open(absolute, flags).catch((error: unknown) => {
      throw ioError(error, path);
    });
    try {
      const opened = await handle.stat();
      if (!sameFile(opened, info)) {
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was opened`, { path });
      }
      await handle.chmod(mode & 0o7777);
    } finally {
      await handle.close();
    }
  }

  private shellLaunch(command: string, cwd: string, env: Record<string, string>): WorkspaceLaunch {
    const shell = this.execConfig.shell;
    if (process.platform === 'win32' && !shell) {
      return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], cwd, env };
    }
    return { file: shell ?? '/bin/sh', args: ['-c', command], cwd, env };
  }

  private inheritedEnv(): Record<string, string> {
    const inherit = this.execConfig.inheritEnv ?? WORKSPACE_INHERITED_ENV;
    const env: Record<string, string> = {};
    const keys = inherit === true ? Object.keys(process.env) : inherit === false ? [] : inherit;
    for (const key of keys) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  private ready(): Promise<string> {
    if (this.state.disposed) {
      const disposed: Error = new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`);
      return Promise.reject(disposed);
    }
    this.state.starting ??= this.open().catch((error: unknown) => {
      this.state.starting = undefined;
      throw error;
    });
    return this.state.starting;
  }

  private async open(): Promise<string> {
    try {
      if (this.create) await mkdir(this.givenRoot, { recursive: true });
      const real = await realpath(this.givenRoot);
      if (!(await stat(real)).isDirectory()) {
        throw new WorkspaceError(
          'NOT_A_DIRECTORY',
          `The root ${this.givenRoot} is not a directory`
        );
      }
      this.state.realRoot = real;
      this.state.sweeping = sweepLeftovers(real, this.leftoverAge).catch(() => undefined);
      return real;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (errnoOf(error) === 'ENOENT') {
        throw new WorkspaceError('NOT_FOUND', `The root ${this.givenRoot} does not exist`, {
          cause: error,
        });
      }
      throw ioError(error, this.givenRoot);
    }
  }

  /**
   * Where `path` is: absolute with symlinks resolved (all of them, or all but the last
   * component), and relative to the root. Refused when it lands outside the root.
   */
  private async locate(
    path: string,
    followFinal: boolean
  ): Promise<{ absolute: string; relative: string }> {
    const root = await this.ready();
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new WorkspaceError('INVALID_PATH', `Invalid path: ${JSON.stringify(path)}`, { path });
    }
    let lexical: string;
    if (isAbsolute(path)) {
      const normalized = resolve(path);
      const base = isWithin(root, normalized)
        ? root
        : isWithin(this.givenRoot, normalized)
          ? this.givenRoot
          : undefined;
      if (!base) throw outside(path, this.givenRoot);
      lexical = join(root, relative(base, normalized));
    } else {
      lexical = resolve(root, path);
    }
    if (!isWithin(root, lexical)) throw outside(path, this.givenRoot);

    const absolute = await canonical(lexical, followFinal, 0, path);
    if (!isWithin(root, absolute)) throw outside(path, this.givenRoot);
    return { absolute, relative: this.relativeOf(absolute) };
  }

  private relativeOf(absolute: string): string {
    return toPosix(relative(this.root, absolute)) || '.';
  }

  private async lstatOf(absolute: string, path: string): Promise<Stats> {
    try {
      return await lstat(absolute);
    } catch (error) {
      throw ioError(error, path);
    }
  }

  /** Creates `.cogitator/` with a `.gitignore` that keeps everything in it out of git. */
  private async ensureServiceDir(): Promise<void> {
    const dir = join(this.root, WORKSPACE_SERVICE_DIR);
    await this.mkdirAt(dir, WORKSPACE_SERVICE_DIR);
    const ignore = join(dir, '.gitignore');
    try {
      const handle = await open(
        ignore,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK,
        0o644
      );
      try {
        await handle.write('*\n');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw ioError(error, `${WORKSPACE_SERVICE_DIR}/.gitignore`);
    }
  }

  /**
   * Refuses to move entries while a process the workspace started runs: such a process can
   * write the root, and swapping a directory at the right moment could otherwise race a move.
   */
  private refuseWhileBusy(path: string): void {
    if (this.state.groups.busy()) {
      throw new WorkspaceError(
        'BUSY',
        `${path} cannot be moved or removed while a command started in the workspace is still running (or left processes in the background): wait for it, or remove it with a command`,
        { path }
      );
    }
  }

  /** Refuses paths of the workspace's own bookkeeping: `.cogitator` itself and its pending moves. */
  private refuseInternal(rel: string, path: string): void {
    if (rel === WORKSPACE_SERVICE_DIR || rel === PENDING_DIR || rel.startsWith(`${PENDING_DIR}/`)) {
      throw new WorkspaceError('INVALID_PATH', `${path} is the workspace's own directory`, {
        path,
      });
    }
  }

  /**
   * Moves the entry at `absolute` into a fresh holder of `.cogitator/pending/` and checks it is
   * the one `before` describes (see `pinEntry`). `undefined` when it is on another device.
   */
  private async pinOrNull(
    absolute: string,
    before: Stats,
    path: string
  ): Promise<PinnedEntry | undefined> {
    await this.ensureServiceDir();
    const pending = join(this.root, ...PENDING_DIR.split('/'));
    await this.mkdirAt(pending, path);
    const holder = join(pending, nanoid(12));
    await mkdir(holder).catch((error: unknown) => {
      throw ioError(error, path);
    });
    await this.verifyParent(holder, path);
    try {
      await this.verifyParent(absolute, path);
      const pinned = await pinEntry(absolute, before, holder, this.root, path);
      if (!pinned) await rmdir(holder).catch(() => undefined);
      return pinned;
    } catch (error) {
      await rmdir(holder).catch(() => undefined);
      throw ioError(error, path);
    }
  }

  /**
   * Removes an entry that cannot be moved aside (it is on another device, such as a mount inside
   * the root): the parent and the entry are checked again right before, a narrower guarantee
   * than the moved-aside removal.
   */
  private async removeInPlace(
    absolute: string,
    before: Stats,
    recursive: boolean,
    path: string
  ): Promise<void> {
    await this.verifyParent(absolute, path);
    const now = await this.lstatOf(absolute, path);
    if (!sameFile(now, before)) {
      throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was being resolved`, {
        path,
      });
    }
    try {
      if (!now.isDirectory()) await unlink(absolute);
      else if (recursive) await rm(absolute, { recursive: true, force: false });
      else await rmdir(absolute);
    } catch (error) {
      throw ioError(error, path);
    }
  }

  /** Throws when the parent directory of `absolute` no longer resolves to itself inside the root. */
  private async verifyParent(absolute: string, path: string): Promise<void> {
    const parent = dirname(absolute);
    const real = await realpath(parent).catch((error: unknown) => {
      throw ioError(error, path);
    });
    if (real !== parent || !isWithin(this.root, real)) {
      throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was being resolved`, {
        path,
      });
    }
  }

  private async mkdirAt(absolute: string, path: string): Promise<void> {
    try {
      await mkdir(absolute, { recursive: true });
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'EEXIST' || code === 'ENOTDIR') {
        throw new WorkspaceError('NOT_A_DIRECTORY', `A parent of ${path} is not a directory`, {
          path,
          cause: error,
        });
      }
      throw ioError(error, path);
    }
    const real = await realpath(absolute).catch((error: unknown) => {
      throw ioError(error, path);
    });
    if (!isWithin(this.root, real)) throw outside(path, this.givenRoot);
  }

  /**
   * Opens `absolute` (already resolved inside the root) without following a symlink in its
   * last component and without blocking on a FIFO, then checks that the path still resolves
   * inside the root to the regular file that was opened, so nothing swapped in between the check
   * and the open slips through. A file this call created and that turns out to be outside the
   * root is removed again.
   */
  private async openVerified(absolute: string, flags: number, path: string): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(absolute, flags | O_NOFOLLOW | O_NONBLOCK, 0o666);
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'EEXIST') throw new WorkspaceError('EXISTS', `${path} exists`, { path });
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} became a symlink while it was opened`, {
          path,
        });
      }
      throw ioError(error, path);
    }
    const created = (flags & constants.O_CREAT) !== 0;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw notAFile(path, opened);
      const again = await realpath(absolute).catch(() => undefined);
      const current = again ? await stat(again).catch(() => undefined) : undefined;
      if (!again || !isWithin(this.root, again) || !current || !sameFile(opened, current)) {
        if (created && again && current && sameFile(opened, current)) {
          await unlink(again).catch(() => undefined);
        }
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was opened`, { path });
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

/**
 * `path` made absolute with every symlink resolved, dangling ones included, and what does not
 * exist yet kept as it is: the real path of its nearest existing ancestor (as `realpath` gives it)
 * with the rest after it, the real path it will have once it is made, so a key built from it
 * stays the same when it is
 */
export function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  return canonicalFrom(absolute, 0, absolute);
}

async function canonicalFrom(path: string, hops: number, given: string): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new WorkspaceError('INVALID_PATH', `Too many symlinks in ${given}`, { path: given });
  }
  const real = await realpath(path).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = dirname(path);
  if (parent === path) return path;
  const here = join(await canonicalFrom(parent, hops, given), basename(path));
  const info = await lstat(here).catch(() => undefined);
  if (!info?.isSymbolicLink()) return here;
  return canonicalFrom(resolve(dirname(here), await readlink(here)), hops + 1, given);
}

/**
 * `path` with every symlink resolved, also a dangling one (which `realpath` refuses, but writing
 * through it would create its target), or all but the last component when `followFinal` is off.
 * Components that do not exist yet are kept as they are.
 */
async function canonical(
  path: string,
  followFinal: boolean,
  hops: number,
  given: string
): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new WorkspaceError('INVALID_PATH', `Too many symlinks in ${given}`, { path: given });
  }
  const parent = dirname(path);
  if (parent === path) return path;
  const realParent = await canonical(parent, true, hops, given);
  const here = join(realParent, basename(path));
  let info: Stats;
  try {
    info = await lstat(here);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return here;
    throw ioError(error, given);
  }
  if (!followFinal || !info.isSymbolicLink()) return here;
  const target = await readlink(here);
  return canonical(resolve(realParent, target), true, hops + 1, given);
}

/** Flushes a directory's entries to disk, where the platform allows it. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

/**
 * Cleans up after interrupted writes and moves, walking at most a few thousand directories and
 * skipping `.git` and `node_modules`. A temporary write file (`.cogitator-tmp-*`, a regular file
 * with one link) whose inode has not changed for `leftoverAge` is deleted: it never was the only copy
 * of anything. An entry left mid-move (`.cogitator-place-*`) may be the only copy of what was
 * moved, so it is never deleted: once untouched for `leftoverAge` (by its inode change time,
 * which a rename updates) it is moved into `.cogitator/pending/recovered-*` and logged. Empty holders of
 * `.cogitator/pending/` are removed.
 */
async function sweepLeftovers(root: string, age: number): Promise<void> {
  const cutoff = age === 0 ? Infinity : Date.now() - age;
  const pending = join(root, ...PENDING_DIR.split('/'));
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < SWEEP_MAX_DIRS) {
    const dir = queue.shift()!;
    visited++;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (dir === pending) {
        const holder = entry.isDirectory() ? await lstat(full).catch(() => undefined) : undefined;
        if (holder && holder.ctimeMs <= cutoff) await rmdir(full).catch(() => undefined);
        continue;
      }
      if (entry.name.startsWith(STAGING_PREFIX)) {
        await recoverStaged(root, full, cutoff);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') queue.push(full);
        continue;
      }
      if (!entry.name.startsWith(TEMP_PREFIX)) continue;
      const info = await lstat(full).catch(() => undefined);
      if (info?.isFile() && info.nlink === 1 && info.ctimeMs <= cutoff) {
        await unlink(full).catch(() => undefined);
      }
    }
  }
}

/** Moves an entry an interrupted move left under its staging name into `.cogitator/pending/`. */
async function recoverStaged(root: string, staged: string, cutoff: number): Promise<void> {
  const info = await lstat(staged).catch(() => undefined);
  if (!info || info.ctimeMs > cutoff) return;
  const holder = join(root, ...PENDING_DIR.split('/'), `recovered-${nanoid(12)}`);
  try {
    await mkdir(holder, { recursive: true });
    if (!isWithin(root, await realpath(holder))) return;
    const kept = join(holder, basename(staged));
    await rename(staged, kept);
    getLogger().warn('An entry an interrupted workspace move left behind was recovered', {
      was: relative(root, staged).split(sep).join('/'),
      now: relative(root, kept).split(sep).join('/'),
    });
  } catch {
    await rmdir(holder).catch(() => undefined);
  }
}

async function readAtMost(handle: FileHandle, limit: number, path: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > limit) throw tooLarge(path, total, limit);
  }
  return Buffer.concat(chunks, total);
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** `cwd` as a path relative to the root with `/` separators, `.` for the root. */
export function normalizeCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return '.';
  if (isAbsolute(cwd)) {
    throw new WorkspaceError('INVALID_PATH', 'cwd must be relative to the root', { path: cwd });
  }
  const normalized = trimTrailingSlashes(posix.normalize(toPosix(cwd)));
  if (normalized === '..' || normalized.startsWith('../')) throw outside(cwd, 'the root');
  return normalized === '' || normalized === '.' ? '.' : normalized;
}

function entryType(info: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): WorkspaceEntryType {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

function notAFile(path: string, info: { isDirectory(): boolean }): WorkspaceError {
  return new WorkspaceError(
    'NOT_A_FILE',
    info.isDirectory() ? `${path} is a directory` : `${path} is not a regular file`,
    { path }
  );
}

function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive number, got ${value}`);
  }
  return value;
}

function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function outside(path: string, root: string): WorkspaceError {
  return new WorkspaceError('OUTSIDE_ROOT', `${path} is outside the workspace (${root})`, { path });
}

function tooLarge(path: string, size: number, limit: number): WorkspaceError {
  return new WorkspaceError(
    'TOO_LARGE',
    `${path} is ${size} bytes or more, over the limit of ${limit} bytes`,
    { path }
  );
}

function ioError(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = errnoOf(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ENOENT':
      return new WorkspaceError('NOT_FOUND', `${path} does not exist`, { path, cause: error });
    case 'ENOTDIR':
      return new WorkspaceError('NOT_A_DIRECTORY', `A parent of ${path} is not a directory`, {
        path,
        cause: error,
      });
    case 'EISDIR':
      return new WorkspaceError('NOT_A_FILE', `${path} is a directory`, { path, cause: error });
    case 'EEXIST':
      return new WorkspaceError('EXISTS', `${path} already exists`, { path, cause: error });
    case 'ENOTEMPTY':
      return new WorkspaceError('NOT_EMPTY', `${path} is not empty`, { path, cause: error });
    case 'EACCES':
    case 'EPERM':
      return new WorkspaceError('DENIED', `${path}: permission denied`, { path, cause: error });
    case 'EINVAL':
      return new WorkspaceError('INVALID_PATH', `${path}: invalid operation`, {
        path,
        cause: error,
      });
    case 'EXDEV':
      return new WorkspaceError('UNSUPPORTED', `${path}: crosses a device boundary`, {
        path,
        cause: error,
      });
    default:
      return new WorkspaceError('IO', `${path}: ${code ?? message}`, { path, cause: error });
  }
}

/** The `LocalWorkspace` behind `workspace`: itself, or the host of a workspace over one */
function localOf(workspace: Workspace): LocalWorkspace | undefined {
  if (workspace instanceof LocalWorkspace) return workspace;
  if ('host' in workspace && workspace.host instanceof LocalWorkspace) return workspace.host;
  return undefined;
}
