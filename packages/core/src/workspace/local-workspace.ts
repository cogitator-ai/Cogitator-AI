import { spawn, type ChildProcess } from 'node:child_process';
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
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SYMLINK_HOPS = 40;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Where `remove({ trash: true })` moves entries, relative to the root. */
export const WORKSPACE_TRASH_DIR = '.cogitator/trash';

/**
 * Environment variables a command inherits from the process by default: what a shell needs to
 * find programs and format text, and nothing that may hold a secret.
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
  exec?: LocalWorkspaceExecConfig;
}

export interface LocalWorkspaceExecConfig {
  /** The POSIX shell commands run with, as `<shell> -c <command>` (default: `/bin/sh`, `cmd.exe` on Windows) */
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
}

interface FileIdentity {
  dev: number;
  ino: number;
}

/**
 * A workspace in a directory of this machine.
 *
 * File operations never leave the root: a path is resolved with every symlink followed (a
 * dangling one too) and refused when it lands outside. Files are opened with `O_NOFOLLOW` and
 * checked again once open: the path must still resolve inside the root, to the very file that
 * was opened, so a symlink swapped in between the check and the open is caught.
 *
 * What it does not stop: a hard link inside the root to a file outside it is that file (it is
 * the same inode, hard links cannot be told from the original), a race that swaps a parent
 * directory for a symlink can leave an empty new file or directory outside the root (never
 * content), and `exec` runs commands as this process with only their directory confined. Use
 * `DockerWorkspace` from `@cogitator-ai/sandbox` for commands you do not trust.
 *
 * Snapshots are not implemented: copying the tree for every checkpoint is too slow for real
 * projects, so `snapshot` and `restore` are left out until a content-addressed store backs them.
 *
 * The workspace starts itself on first use, `start()` only makes errors (a missing root with
 * `create: false`) surface early. `dispose()` kills the commands still running.
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
  private readonly execConfig: LocalWorkspaceExecConfig;
  private realRoot?: string;
  private starting?: Promise<string>;
  private disposed = false;
  private readonly running = new Set<ChildProcess>();

  constructor(options: LocalWorkspaceOptions) {
    if (!options.root) throw new WorkspaceError('INVALID_PATH', 'A workspace needs a root');
    this.givenRoot = resolve(options.root);
    this.id = options.id ?? `workspace_${nanoid(10)}`;
    this.cwd = normalizeCwd(options.cwd);
    this.create = options.create ?? true;
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
    this.execConfig = options.exec ?? {};
    positive(this.execConfig.timeout, DEFAULT_EXEC_TIMEOUT, 'exec.timeout');
    positive(this.execConfig.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'exec.maxOutputBytes');
  }

  /** The root with symlinks resolved once started, the given root before */
  get root(): string {
    return this.realRoot ?? this.givenRoot;
  }

  async start(): Promise<void> {
    await this.ready();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const child of this.running) killTree(child);
    this.running.clear();
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
    const handle = await this.openVerified(absolute, constants.O_RDONLY, path);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceError('NOT_A_FILE', `${path} is not a file`, { path });
      if (info.size > limit) throw tooLarge(path, info.size, limit);
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

    const handle = await this.openForWrite(absolute, path);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceError('NOT_A_FILE', `${path} is not a file`, { path });
      await handle.truncate(0);
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
    } finally {
      await handle.close();
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
    if (rel === '.')
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be removed', { path });
    const info = await this.lstatOf(absolute, path);
    if (info.isDirectory() && !options.recursive && (await readdir(absolute)).length > 0) {
      throw new WorkspaceError(
        'NOT_EMPTY',
        `${path} is a directory with entries, pass recursive to remove it`,
        { path }
      );
    }
    await this.verifyParent(absolute, path);

    if (options.trash) {
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${nanoid(6)}`;
      const trashedTo = `${WORKSPACE_TRASH_DIR}/${stamp}/${rel}`;
      const target = join(this.root, ...trashedTo.split('/'));
      await this.mkdirAt(dirname(target), path);
      try {
        await rename(absolute, target);
      } catch (error) {
        throw ioError(error, path);
      }
      return { path: rel, trashedTo };
    }

    try {
      await rm(absolute, { recursive: info.isDirectory(), force: false });
    } catch (error) {
      throw ioError(error, path);
    }
    return { path: rel };
  }

  async rename(from: string, to: string, options: WorkspaceRenameOptions = {}): Promise<void> {
    const source = await this.locate(from, false);
    const target = await this.locate(to, false);
    if (source.relative === '.' || target.relative === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be moved', { path: from });
    }
    await this.lstatOf(source.absolute, from);
    if (!options.overwrite) {
      const taken = await lstat(target.absolute).then(
        () => true,
        () => false
      );
      if (taken) throw new WorkspaceError('EXISTS', `${to} already exists`, { path: to });
    }
    await this.mkdirAt(dirname(target.absolute), to);
    await this.verifyParent(source.absolute, from);
    await this.verifyParent(target.absolute, to);
    try {
      await rename(source.absolute, target.absolute);
    } catch (error) {
      throw ioError(error, from);
    }
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
    if (options.signal?.aborted) throw aborted(options.signal);

    const env = { ...this.inheritedEnv(), ...this.execConfig.env, ...options.env };
    return runProcess(command, {
      cwd,
      env,
      timeout,
      maxOutput,
      shell: this.execConfig.shell,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      track: (child) => {
        this.running.add(child);
        return () => this.running.delete(child);
      },
    });
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
    if (this.disposed) {
      return Promise.reject(new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`));
    }
    this.starting ??= this.open().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
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
      this.realRoot = real;
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

  private async openForWrite(absolute: string, path: string): Promise<FileHandle> {
    try {
      return await this.openVerified(
        absolute,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        path
      );
    } catch (error) {
      if (!WorkspaceError.is(error, 'EXISTS')) throw error;
      return this.openVerified(absolute, constants.O_WRONLY, path);
    }
  }

  /**
   * Opens `absolute` (already resolved inside the root) without following a symlink in its
   * last component, then checks that the path still resolves inside the root to the file that
   * was opened, so nothing swapped in between the check and the open slips through.
   */
  private async openVerified(absolute: string, flags: number, path: string): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(absolute, flags | O_NOFOLLOW, 0o666);
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
    try {
      const opened = await handle.stat();
      const again = await realpath(absolute).catch(() => undefined);
      const current = again ? await stat(again).catch(() => undefined) : undefined;
      if (!again || !isWithin(this.root, again) || !current || !sameFile(opened, current)) {
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} changed while it was opened`, { path });
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxOutput: number;
  shell?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Registers the child, returns how to unregister it */
  track: (child: ChildProcess) => () => void;
}

function runProcess(command: string, options: RunProcessOptions): Promise<WorkspaceExecResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  const stdout = new CappedText(options.maxOutput, options.onStdout);
  const stderr = new CappedText(options.maxOutput, options.onStderr);

  return new Promise<WorkspaceExecResult>((resolvePromise, reject) => {
    const child = windows
      ? spawn(command, {
          cwd: options.cwd,
          env: options.env,
          shell: options.shell ?? true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(options.shell ?? '/bin/sh', ['-c', command], {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    const untrack = options.track(child);
    let timedOut = false;
    let abortedBy: AbortSignal | undefined;
    let settled = false;

    const stop = () => {
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeout);
    const onAbort = () => {
      abortedBy = options.signal;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      untrack();
      if (abortedBy) {
        reject(aborted(abortedBy));
        return;
      }
      if (extraStderr) stderr.push(extraStderr);
      resolvePromise({
        stdout: stdout.text(),
        stderr: timedOut
          ? stderr.text() || `Command timed out after ${options.timeout}ms`
          : stderr.text(),
        exitCode: timedOut ? 124 : exitCode,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 127 : error.code === 'EACCES' ? 126 : 1;
      finish(code, error.message);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
  });
}

/** Kills a command and every process it started (its process group, outside Windows). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid !== undefined)
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Text of a stream up to a byte limit, decoded without splitting a character, every piece reported. */
class CappedText {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly listener?: (chunk: string) => void
  ) {}

  push(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.listener) {
      const text = this.decoder.write(buffer);
      if (text) this.listener(text);
    }
    const room = this.limit - this.size;
    if (buffer.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = buffer.length > room ? buffer.subarray(0, room) : buffer;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    if (this.listener) {
      const rest = this.decoder.end();
      if (rest) this.listener(rest);
    }
    return new StringDecoder('utf8').end(Buffer.concat(this.chunks));
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

function normalizeCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return '.';
  if (isAbsolute(cwd)) {
    throw new WorkspaceError('INVALID_PATH', 'cwd must be relative to the root', { path: cwd });
  }
  const normalized = toPosix(relative('/', resolve('/', cwd)));
  if (normalized.startsWith('..')) throw outside(cwd, 'the root');
  return normalized || '.';
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

function aborted(signal: AbortSignal): WorkspaceError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return new WorkspaceError('ABORTED', detail ? `Command aborted: ${detail}` : 'Command aborted', {
    cause: reason,
  });
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
    case 'EINVAL':
      return new WorkspaceError('INVALID_PATH', `${path}: ${message}`, { path, cause: error });
    default:
      return new WorkspaceError('IO', `${path}: ${message}`, { path, cause: error });
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGSEGV: 11,
    SIGPIPE: 13,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 0;
}
