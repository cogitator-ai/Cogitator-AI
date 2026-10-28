import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { OsSandboxAvailability, OsSandboxKind } from '@cogitator-ai/types';
import { innerBubblewrap, type BubblewrapNesting } from './bubblewrap';
import { seccompArch, seccompFilter, type SeccompArch } from './seccomp';
import { SANDBOX_EXEC } from './seatbelt';

const PROBE_TIMEOUT = 15_000;

/**
 * What the sandbox found on this machine: whether it runs, and on Linux the binaries it uses and
 * how it keeps commands from making namespaces of their own
 */
export type OsSandboxProbe = OsSandboxAvailability & {
  bwrap?: string;
  socat?: string;
  nesting?: BubblewrapNesting;
};

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Linux: `bwrap` to use instead of the one on `PATH` */
  bwrapPath?: string;
  /** Linux: `socat` to use instead of the one on `PATH` */
  socatPath?: string;
  /** Linux: the CPU to build the seccomp filter for (default: this one), for tests */
  arch?: string;
  /**
   * Linux: whether commands may connect to every Unix socket (`network.allowAllUnixSockets`),
   * the one case where the sandbox runs without its seccomp filter, on `--disable-userns` alone.
   * Otherwise the filter is required: it is what keeps commands from the Docker socket or an SSH
   * agent, which the network namespace does not hide
   */
  allowAllUnixSockets?: boolean;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The program `name` on `PATH`, or the absolute path given for it when it is executable */
export async function findProgram(name: string, given?: string): Promise<string | undefined> {
  if (given !== undefined) {
    return isAbsolute(given) && (await executable(given)) ? given : undefined;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function run(
  file: string,
  args: readonly string[],
  inputs: readonly Uint8Array[] = []
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr: stderr || extra });
    };
    const child = spawn(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe', ...inputs.map(() => 'pipe' as const)],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(1, `timed out after ${PROBE_TIMEOUT}ms`);
    }, PROBE_TIMEOUT);
    inputs.forEach((bytes, index) => {
      const pipe = child.stdio[3 + index];
      if (!pipe || !('write' in pipe)) return;
      pipe.on('error', () => undefined);
      pipe.end(Buffer.from(bytes));
    });
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** The version `bwrap --version` prints (`bubblewrap 0.8.0`), undefined when it prints none */
export function bubblewrapVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Whether a bubblewrap version has `--disable-userns` (0.8.0 and later) */
export function supportsDisableUserns(version: readonly number[] | undefined): boolean {
  if (!version) return false;
  const [major, minor] = version;
  return major > 0 || minor >= 8;
}

/**
 * The ways to keep commands from making namespaces of their own to try, strongest first: both
 * `--disable-userns` and the seccomp filter, then each alone, as far as this bubblewrap and this
 * CPU have them. `--disable-userns` alone only when commands may reach every Unix socket anyway
 * (`allowAllUnixSockets`): the seccomp filter is also what keeps them from Unix sockets
 */
export function nestingCandidates(
  disableUserns: boolean,
  arch: SeccompArch | undefined,
  allowAllUnixSockets = false
): BubblewrapNesting[] {
  const seccomp = arch !== undefined;
  const candidates: BubblewrapNesting[] = [];
  if (disableUserns && seccomp) candidates.push({ disableUserns: true, seccomp: true });
  if (seccomp) candidates.push({ disableUserns: false, seccomp: true });
  if (disableUserns && allowAllUnixSockets)
    candidates.push({ disableUserns: true, seccomp: false });
  return candidates;
}

/**
 * Whether the OS sandbox runs on this machine: `sandbox-exec` on macOS, `bwrap` and `socat` on
 * Linux, each tried once with a command that does nothing, so a blocked user namespace (a
 * container, an AppArmor restriction) is found before the first real command
 */
export async function probeOsSandbox(options: ProbeOptions = {}): Promise<OsSandboxProbe> {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    const kind: OsSandboxKind = 'seatbelt';
    if (!(await executable(SANDBOX_EXEC))) {
      return { available: false, kind, reason: `${SANDBOX_EXEC} is missing` };
    }
    const tried = await run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    return tried.code === 0
      ? { available: true, kind }
      : { available: false, kind, reason: `sandbox-exec does not run: ${tried.stderr.trim()}` };
  }
  if (platform === 'linux') {
    const kind: OsSandboxKind = 'bubblewrap';
    const bwrap = await findProgram('bwrap', options.bwrapPath);
    if (!bwrap) {
      return {
        available: false,
        kind,
        reason: options.bwrapPath
          ? `bwrapPath ${options.bwrapPath} is not an executable absolute path`
          : 'bubblewrap (bwrap) is not installed: install the bubblewrap package',
      };
    }
    const socat = await findProgram('socat', options.socatPath);
    if (!socat) {
      return {
        available: false,
        kind,
        reason: options.socatPath
          ? `socatPath ${options.socatPath} is not an executable absolute path`
          : 'socat is not installed: install the socat package',
      };
    }
    const truePath = (await executable('/bin/true')) ? '/bin/true' : '/usr/bin/true';
    const outer = [
      '--new-session',
      '--die-with-parent',
      '--unshare-net',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
    ];
    const tried = await run(bwrap, [...outer, truePath]);
    if (tried.code !== 0) {
      return {
        available: false,
        kind,
        reason: `bwrap cannot create its namespaces here (${tried.stderr.trim()}): unprivileged user namespaces may be disabled (kernel.unprivileged_userns_clone, kernel.apparmor_restrict_unprivileged_userns) or the process runs in a container that forbids them`,
      };
    }
    const version = bubblewrapVersion((await run(bwrap, ['--version'])).stdout);
    const arch = seccompArch(options.arch);
    const failures: string[] = [];
    const candidates = nestingCandidates(
      supportsDisableUserns(version),
      arch,
      options.allowAllUnixSockets === true
    );
    for (const nesting of candidates) {
      const inputs =
        nesting.seccomp && arch ? [seccompFilter({ arch, allowUnixSockets: false })] : [];
      const nested = await run(
        bwrap,
        [...outer, '--', ...innerBubblewrap(bwrap, nesting, '/', truePath, [])],
        inputs
      );
      if (nested.code === 0) return { available: true, kind, bwrap, socat, nesting };
      failures.push(nested.stderr.trim());
    }
    const missing = [
      ...(supportsDisableUserns(version)
        ? []
        : [
            `bwrap ${version?.join('.') ?? '(unknown version)'} has no --disable-userns (0.8.0 or later)`,
          ]),
      ...(arch ? [] : [`no seccomp filter for the ${options.arch ?? process.arch} CPU`]),
      ...failures.filter(Boolean),
    ];
    if (!arch && options.allowAllUnixSockets !== true) {
      return {
        available: false,
        kind,
        reason: `there is no seccomp filter for the ${options.arch ?? process.arch} CPU, and without it commands could connect to every Unix socket (the Docker socket, an SSH agent): set network.allowAllUnixSockets to run with --disable-userns alone`,
      };
    }
    return {
      available: false,
      kind,
      reason: `bwrap cannot keep commands from making namespaces of their own and from Unix sockets, which would let them undo the protected paths or bypass the proxy (${missing.join('; ')})`,
    };
  }
  return {
    available: false,
    reason: `the OS sandbox runs on macOS and Linux, not on ${platform}`,
  };
}
