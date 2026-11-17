import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Where the bridge of this machine keeps its files. */
export interface BridgePaths {
  home: string;
  database: string;
  /** A unix socket path, or the name of a named pipe on Windows */
  socket: string;
}

export interface BridgePathsOptions {
  /** The folder of the files: `COGITATOR_BRIDGE_HOME` by default, else `~/.cogitator/bridge` */
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The longest path a unix socket takes on macOS, the tighter of the platforms, less the NUL */
const MAX_SOCKET_PATH = 103;

function userName(): string {
  try {
    return userInfo().username;
  } catch {
    return 'user';
  }
}

function pipeName(home: string): string {
  const tag = createHash('sha256').update(`${userName()}\0${home}`).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\cogitator-bridge-${tag}`;
}

/**
 * The files of the bridge: one folder per machine, shared by every project, so the sessions of
 * all of them meet in one place.
 */
export function bridgePaths(options: BridgePathsOptions = {}): BridgePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = options.home ?? env.COGITATOR_BRIDGE_HOME?.trim();
  const home = configured ? resolve(configured) : join(homedir(), '.cogitator', 'bridge');
  const socket = platform === 'win32' ? pipeName(home) : join(home, 'bridge.sock');
  if (platform !== 'win32' && Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new Error(
      `The bridge socket path is too long for a unix socket (${Buffer.byteLength(socket)} bytes, ` +
        `the limit is ${MAX_SOCKET_PATH}): ${socket}. Set COGITATOR_BRIDGE_HOME to a shorter folder`
    );
  }
  return { home, database: join(home, 'bridge.db'), socket };
}

/** A `.git` file is a line or two. Anything larger is not one, and is not read. */
const MAX_GIT_FILE_BYTES = 4096;

function gitEntry(dir: string): 'dir' | 'file' | undefined {
  try {
    const stat = statSync(join(dir, '.git'));
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() && stat.size <= MAX_GIT_FILE_BYTES ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a small plain file, or undefined: a pipe, a device or a large file is not read. */
function readSmallFile(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_GIT_FILE_BYTES) return undefined;
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * The main checkout a linked worktree belongs to, read from its `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`), or undefined when the file says something else, as
 * the `.git` file of a submodule does, or when the main checkout does not name this folder as
 * its worktree: a folder cannot join a project by claiming it.
 */
function mainCheckoutOf(worktree: string): string | undefined {
  const content = readSmallFile(join(worktree, '.git'));
  const match = content === undefined ? null : /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) return undefined;
  const named = match[1].trim();
  const gitDir = isAbsolute(named) ? named : resolve(worktree, named);
  const worktrees = dirname(gitDir);
  if (basename(worktrees) !== 'worktrees') return undefined;
  const commonDir = dirname(worktrees);
  if (basename(commonDir) !== '.git') return undefined;
  const back = readSmallFile(join(gitDir, 'gitdir'))?.trim();
  if (!back) return undefined;
  const claimed = isAbsolute(back) ? back : resolve(gitDir, back);
  return samePath(claimed, join(worktree, '.git')) ? dirname(commonDir) : undefined;
}

/**
 * One spelling for a folder however it was reached: absolute, and with the symlinks of as much
 * of it as exists resolved, so `/tmp/app` and `/private/tmp/app` are the same project, and a
 * folder not made yet inside either is inside both.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      if (dirname(current) === current) return absolute;
      missing.push(basename(current));
    }
  }
}

/** Whether `path` is `folder` or lies inside it. */
export function isInside(folder: string, path: string): boolean {
  const inner = relative(resolve(folder), resolve(path));
  if (inner === '') return true;
  return inner !== '..' && !inner.startsWith(`..${sep}`) && !isAbsolute(inner);
}

/**
 * The checkout `cwd` is in: the nearest folder up the tree with a `.git`, the main checkout or a
 * linked worktree alike. `cwd` itself when no folder up the tree is a repository.
 */
export function findCheckoutRoot(cwd: string): string {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (gitEntry(dir)) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/**
 * Where the worktrees of jobs go, under the main checkout of a project: the folder the runtime
 * keeps the worktrees of its isolated subagents in, so one `.gitignore` there covers both.
 */
export const JOB_WORKTREES_DIR = join('.cogitator', 'worktrees');

/** Whether `cwd` is inside a git checkout, the main one of a repository or a linked worktree. */
export function inCheckout(cwd: string): boolean {
  return gitEntry(findCheckoutRoot(cwd)) !== undefined;
}

/**
 * The root of the project `cwd` is in: the nearest folder up the tree with a `.git`, and for a
 * linked git worktree the main checkout it belongs to, so every worktree of a repository is one
 * project. `cwd` itself when no folder up the tree is a repository.
 */
export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const entry = gitEntry(dir);
    if (entry === 'dir') return dir;
    if (entry === 'file') return mainCheckoutOf(dir) ?? dir;
    if (dirname(dir) === dir) return start;
  }
}
