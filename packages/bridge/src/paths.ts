import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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

function gitEntry(dir: string): 'dir' | 'file' | undefined {
  const path = join(dir, '.git');
  if (!existsSync(path)) return undefined;
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return undefined;
  }
}

/**
 * The main checkout a linked worktree belongs to, read from its `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`), or undefined when the file says something else,
 * as the `.git` file of a submodule does.
 */
function mainCheckoutOf(worktree: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(worktree, '.git'), 'utf-8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) return undefined;
  const gitDir = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(worktree, match[1].trim());
  const worktrees = dirname(gitDir);
  if (basename(worktrees) !== 'worktrees') return undefined;
  const commonDir = dirname(worktrees);
  return basename(commonDir) === '.git' ? dirname(commonDir) : undefined;
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
