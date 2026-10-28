/**
 * The bubblewrap command line a command runs under on Linux: the root file system read-only,
 * the writable roots bound read-write, denied reads hidden behind empty mounts, write-protected
 * paths bound read-only over the writable roots, and a network namespace of its own whose only
 * way out is a `socat` bridge from a loopback port to the proxy's Unix socket. The command itself
 * runs in a second bubblewrap inside the first, which keeps it from making namespaces of its own
 * (`--disable-userns`, a seccomp filter) once the bridge, which needs a Unix socket, is up
 */

import { shellQuote } from '../workspace/remote/shell-quote';
import { depthOf, isWithin } from './paths';

/** The loopback port inside the sandbox the proxy bridge listens on */
export const BRIDGE_PORT = 3128;

export interface BubblewrapPath {
  path: string;
  directory: boolean;
  exists: boolean;
  /** Where a symlink at `path` leads, when it is one: what a bind of it would show */
  real?: string;
  /**
   * Only the entry itself is write-protected: an existing directory is bound read-write over
   * itself, so it becomes a mount point no command can remove, rename or replace, while what it
   * holds stays writable
   */
  entryOnly?: boolean;
}

/**
 * How the command is kept from making a user or mount namespace of its own, where it would hold
 * every capability over a copy of the mount tree. At least one is needed
 */
export interface BubblewrapNesting {
  /** `--unshare-user --disable-userns` (bubblewrap 0.8.0 and later) */
  disableUserns: boolean;
  /** The seccomp filter, read from descriptor 3 (`--seccomp 3`) */
  seccomp: boolean;
}

/**
 * The inner bubblewrap that runs `file args` in `cwd`: the outer sandbox's whole view bound as it
 * is (the read-only binds stay read-only, and a namespace made below them cannot undo them), with
 * the nesting protections applied right before the command starts
 */
export function innerBubblewrap(
  bwrap: string,
  nesting: BubblewrapNesting,
  cwd: string,
  file: string,
  args: readonly string[]
): string[] {
  if (!nesting.disableUserns && !nesting.seccomp) {
    throw new Error(
      'A bubblewrap sandbox needs --disable-userns or a seccomp filter to keep commands from making namespaces of their own'
    );
  }
  return [
    bwrap,
    '--die-with-parent',
    ...(nesting.disableUserns ? ['--unshare-user', '--disable-userns'] : []),
    ...(nesting.seccomp ? ['--seccomp', '3'] : []),
    '--dev-bind',
    '/',
    '/',
    '--chdir',
    cwd,
    '--',
    file,
    ...args,
  ];
}

export interface BubblewrapInput {
  /** The `bwrap` binary */
  bwrap: string;
  /** The `socat` binary */
  socat: string;
  /** Existing directories and files commands may write */
  writable: readonly string[];
  /** Paths not writable inside the writable roots, existing or not */
  denyWrite: readonly BubblewrapPath[];
  /** Existing paths hidden from reads */
  denyRead: readonly BubblewrapPath[];
  /** Existing paths readable again inside a hidden one */
  allowRead: readonly string[];
  filesystemDisabled: boolean;
  /** The Unix socket of the proxy on the host */
  proxySocket: string;
  /** An empty directory of the sandbox's own, bound read-only where a protected directory is missing */
  emptyDir: string;
  cwd: string;
  file: string;
  args: readonly string[];
  /** Whether bubblewrap has `--disable-userns`, see {@link BubblewrapNesting} */
  disableUserns: boolean;
  /** The seccomp filter's bytes, see `seccompFilter`, when the CPU has one */
  seccomp?: Uint8Array;
}

export interface BubblewrapCommand {
  file: string;
  args: string[];
  /** What to write to descriptor 3 and on: the seccomp filter */
  extraInputs: Uint8Array[];
  /**
   * Mount points bubblewrap creates on the host for protected paths that do not exist yet (an
   * empty file or directory), to remove once the command is over
   */
  mountPoints: string[];
}

interface Mount {
  path: string;
  /** Applied after the mounts of lower ranks at the same depth */
  rank: number;
  args: string[];
}

/** The first missing component of `path` below `root`, where a mount over it can go */
function firstMissing(path: string, existing: (path: string) => boolean): string {
  const parts = path.split('/');
  for (let i = 2; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (!existing(prefix)) return prefix;
  }
  return path;
}

/**
 * Whether reading `path` is denied: the narrowest `denyRead` or `allowRead` entry over it is a
 * deny (a deny wins a tie). A write-protected path hidden this way gets no read-only bind of its
 * own, which would show its content again over the empty mount that hides it
 */
export function readHidden(
  path: string,
  denyRead: readonly BubblewrapPath[],
  allowRead: readonly string[]
): boolean {
  let best: { depth: number; deny: boolean } | undefined;
  const consider = (depth: number, deny: boolean) => {
    if (!best || depth > best.depth || (depth === best.depth && deny)) best = { depth, deny };
  };
  for (const entry of denyRead) if (isWithin(entry.path, path)) consider(depthOf(entry.path), true);
  for (const entry of allowRead) if (isWithin(entry, path)) consider(depthOf(entry), false);
  return best?.deny === true;
}

/** The bubblewrap command line for `input` */
export function bubblewrapCommand(
  input: BubblewrapInput,
  existing: (path: string) => boolean
): BubblewrapCommand {
  const args = ['--new-session', '--die-with-parent', '--unshare-net', '--unshare-pid'];
  args.push(input.filesystemDisabled ? '--bind' : '--ro-bind', '/', '/');
  args.push('--dev', '/dev', '--proc', '/proc');
  const mounts: Mount[] = [];
  const mountPoints: string[] = [];
  if (!input.filesystemDisabled) {
    const writableAt = (path: string) => input.writable.some((root) => isWithin(root, path));
    const hidden = (path: string) => readHidden(path, input.denyRead, input.allowRead);
    for (const path of input.writable) mounts.push({ path, rank: 0, args: ['--bind', path, path] });
    for (const entry of input.denyRead) {
      mounts.push({
        path: entry.path,
        rank: 1,
        args: entry.directory ? ['--tmpfs', entry.path] : ['--ro-bind', '/dev/null', entry.path],
      });
    }
    for (const path of input.allowRead) {
      const denied = input.denyWrite.some((entry) => isWithin(entry.path, path));
      mounts.push({
        path,
        rank: 2,
        args: [writableAt(path) && !denied ? '--bind' : '--ro-bind', path, path],
      });
    }
    for (const entry of input.denyWrite) {
      if (!writableAt(entry.path)) continue;
      if (entry.exists) {
        if (hidden(entry.path) || (entry.real !== undefined && hidden(entry.real))) continue;
        const bind = entry.entryOnly && entry.directory ? '--bind' : '--ro-bind';
        mounts.push({ path: entry.path, rank: 3, args: [bind, entry.path, entry.path] });
        continue;
      }
      const at = firstMissing(entry.path, existing);
      if (mountPoints.includes(at)) continue;
      const directory = at !== entry.path || entry.directory;
      mountPoints.push(at);
      mounts.push({
        path: at,
        rank: 3,
        args: directory ? ['--ro-bind', input.emptyDir, at] : ['--ro-bind', '/dev/null', at],
      });
    }
  }
  mounts.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.rank - b.rank);
  for (const mount of mounts) args.push(...mount.args);
  const socketDir = input.proxySocket.slice(0, input.proxySocket.lastIndexOf('/')) || '/';
  args.push('--ro-bind', socketDir, socketDir);
  args.push('--chdir', input.cwd, '--', '/bin/sh', '-c', bridgeScript(input), 'cogitator-sandbox');
  const nesting = { disableUserns: input.disableUserns, seccomp: input.seccomp !== undefined };
  args.push(...innerBubblewrap(input.bwrap, nesting, input.cwd, input.file, input.args));
  return {
    file: input.bwrap,
    args,
    mountPoints,
    extraInputs: input.seccomp ? [input.seccomp] : [],
  };
}

/**
 * The script that starts the bridge from the loopback port to the proxy socket, waits until it
 * listens, and runs the command in its place
 */
export function bridgeScript(input: Pick<BubblewrapInput, 'socat' | 'proxySocket'>): string {
  const socat = shellQuote(input.socat);
  const listen = shellQuote(`TCP-LISTEN:${BRIDGE_PORT},bind=127.0.0.1,fork,reuseaddr`);
  const target = shellQuote(`UNIX-CONNECT:${input.proxySocket}`);
  const probe = shellQuote(`TCP:127.0.0.1:${BRIDGE_PORT}`);
  return [
    `${socat} ${listen} ${target} >/dev/null 2>&1 &`,
    'i=0',
    `while [ "$i" -lt 300 ]; do ${socat} -u OPEN:/dev/null ${probe} >/dev/null 2>&1 && break; i=$((i+1)); sleep 0.01; done`,
    'exec "$@"',
  ].join('\n');
}
