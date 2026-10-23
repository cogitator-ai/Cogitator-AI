import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import {
  WorkspaceError,
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
  type WorkspaceStat,
  type WorkspaceWriteOptions,
} from '@cogitator-ai/types';
import { globMatcher } from './glob';
import { abortError, ProcessGroups, runProcess, type WorkspaceLaunch } from './process';

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
  exec?: LocalWorkspaceExecConfig;
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
  disposed: boolean;
  groups: ProcessGroups;
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
 * Snapshots are not implemented: copying the tree for every checkpoint is too slow for real
 * projects, so `snapshot` and `restore` are left out until a content-addressed store backs them.
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
  private readonly execConfig: LocalWorkspaceExecConfig;
  private readonly state: LocalWorkspaceState;

  constructor(options: LocalWorkspaceOptions) {
    if (!options.root) throw new WorkspaceError('INVALID_PATH', 'A workspace needs a root');
    this.givenRoot = resolve(options.root);
    this.id = options.id ?? `workspace_${nanoid(10)}`;
    this.cwd = normalizeCwd(options.cwd);
    this.create = options.create ?? true;
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
    this.refuseHardLinks = options.refuseHardLinks ?? false;
    this.execConfig = options.exec ?? {};
    positive(this.execConfig.timeout, DEFAULT_EXEC_TIMEOUT, 'exec.timeout');
    positive(this.execConfig.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'exec.maxOutputBytes');
    positive(this.execConfig.killGrace, DEFAULT_KILL_GRACE, 'exec.killGrace');
    this.state = { disposed: false, groups: new ProcessGroups() };
  }

  /** The root with symlinks resolved once started, the given root before */
  get root(): string {
    return this.state.realRoot ?? this.givenRoot;
  }

  async start(): Promise<void> {
    await this.ready();
  }

  async dispose(): Promise<void> {
    this.state.disposed = true;
    this.state.groups.killAll();
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
    if (options.createParents ?? true) await this.mkdirAt(dirname(absolute), path);
    if (rel === WORKSPACE_SERVICE_DIR || rel.startsWith(`${WORKSPACE_SERVICE_DIR}/`)) {
      await this.ensureServiceDir();
    }

    const existing = await lstat(absolute).catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT') return undefined;
      throw ioError(error, path);
    });
    if (existing && !existing.isFile()) throw notAFile(path, existing);

    const temp = join(dirname(absolute), `.cogitator-tmp-${nanoid(12)}`);
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
      await handle.close();
      await this.verifyParent(absolute, path);
      await rename(temp, absolute).catch((error: unknown) => {
        throw ioError(error, path);
      });
      renamed = true;
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
    const matches = options.glob ? globMatcher(options.glob) : undefined;
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
    if (rel === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be removed', { path });
    }
    const info = await this.lstatOf(absolute, path);
    if (info.isDirectory() && !options.recursive && (await readdir(absolute)).length > 0) {
      throw new WorkspaceError(
        'NOT_EMPTY',
        `${path} is a directory with entries, pass recursive to remove it`,
        { path }
      );
    }

    if (rel === WORKSPACE_SERVICE_DIR) {
      if (options.trash) {
        throw new WorkspaceError('INVALID_PATH', 'The trash cannot be moved to the trash', {
          path,
        });
      }
      await this.verifyParent(absolute, path);
      await rm(absolute, { recursive: true, force: false }).catch((error: unknown) => {
        throw ioError(error, path);
      });
      return { path: rel };
    }

    const pinned = await this.pin(absolute, info, path);
    if (options.trash) {
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${nanoid(6)}`;
      const trashedTo = `${WORKSPACE_TRASH_DIR}/${stamp}/${rel}`;
      const target = join(this.root, ...trashedTo.split('/'));
      await this.mkdirAt(dirname(target), path);
      await this.verifyParent(target, path);
      await rename(pinned.at, target).catch(async (error: unknown) => {
        await pinned.undo();
        throw ioError(error, path);
      });
      await pinned.release();
      return { path: rel, trashedTo };
    }

    await this.verifyParent(pinned.at, path);
    await rm(pinned.at, { recursive: true, force: false }).catch((error: unknown) => {
      throw ioError(error, path);
    });
    await pinned.release();
    return { path: rel };
  }

  async rename(from: string, to: string, options: WorkspaceRenameOptions = {}): Promise<void> {
    const source = await this.locate(from, false);
    const target = await this.locate(to, false);
    if (source.relative === '.' || target.relative === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be moved', { path: from });
    }
    if (target.relative === source.relative) return;
    if (target.relative.startsWith(`${source.relative}/`)) {
      throw new WorkspaceError('INVALID_PATH', `${to} is inside ${from}`, { path: to });
    }
    const info = await this.lstatOf(source.absolute, from);
    const taken = await lstat(target.absolute).then(
      () => true,
      () => false
    );
    if (taken && !options.overwrite) {
      throw new WorkspaceError('EXISTS', `${to} already exists`, { path: to });
    }
    await this.mkdirAt(dirname(target.absolute), to);

    const pinned = await this.pin(source.absolute, info, from);
    await this.verifyParent(target.absolute, to).catch(async (error: unknown) => {
      await pinned.undo();
      throw error;
    });
    await rename(pinned.at, target.absolute).catch(async (error: unknown) => {
      await pinned.undo();
      throw ioError(error, from);
    });
    const landed = await realpath(dirname(target.absolute)).catch(() => undefined);
    if (landed !== dirname(target.absolute)) {
      await rename(target.absolute, pinned.at).catch(() => undefined);
      await pinned.undo();
      throw new WorkspaceError('OUTSIDE_ROOT', `${to} changed while it was being moved`, {
        path: to,
      });
    }
    await pinned.release();
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
    this.state.groups.prune();
    return runProcess({
      launch,
      timeout,
      maxOutput,
      killGrace: this.execConfig.killGrace ?? DEFAULT_KILL_GRACE,
      groups: this.state.groups,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
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
      return Promise.reject(new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`));
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
   * Moves the entry at `absolute` into `.cogitator/pending/` and checks it is the one `before`
   * describes. When a parent directory was swapped for a symlink in between, the entry moved is
   * another one: it goes back where it came from and the operation is refused.
   */
  private async pin(
    absolute: string,
    before: FileIdentity,
    path: string
  ): Promise<{ at: string; undo: () => Promise<void>; release: () => Promise<void> }> {
    await this.ensureServiceDir();
    const holder = join(this.root, ...PENDING_DIR.split('/'), nanoid(12));
    await this.mkdirAt(holder, path);
    const at = join(holder, 'entry');
    const release = () => rm(holder, { recursive: true, force: true }).catch(() => undefined);
    const undo = async () => {
      await rename(at, absolute).catch(() => undefined);
      await release();
    };
    await this.verifyParent(absolute, path).catch(async (error: unknown) => {
      await release();
      throw error;
    });
    try {
      await rename(absolute, at);
    } catch (error) {
      await release();
      throw ioError(error, path);
    }
    const moved = await lstat(at).catch(() => undefined);
    if (!moved || !sameFile(moved, before)) {
      await undo();
      throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was being resolved`, {
        path,
      });
    }
    return { at, undo, release };
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
  const normalized = posix.normalize(toPosix(cwd)).replace(/\/+$/, '');
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
      return new WorkspaceError('INVALID_PATH', `${path}: ${message}`, { path, cause: error });
    default:
      return new WorkspaceError('IO', `${path}: ${message}`, { path, cause: error });
  }
}
