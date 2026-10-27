import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { OsSandboxAvailability, OsSandboxKind } from '@cogitator-ai/types';
import { SANDBOX_EXEC } from './seatbelt';

const PROBE_TIMEOUT = 15_000;

/** What the sandbox found on this machine: whether it runs, and the binaries it uses on Linux */
export type OsSandboxProbe = OsSandboxAvailability & { bwrap?: string; socat?: string };

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Linux: `bwrap` to use instead of the one on `PATH` */
  bwrapPath?: string;
  /** Linux: `socat` to use instead of the one on `PATH` */
  socatPath?: string;
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

function run(file: string, args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT }, (error, _stdout, stderr) => {
      if (!error) {
        resolveRun({ code: 0, stderr: String(stderr) });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : 1;
      resolveRun({ code, stderr: String(stderr) || error.message });
    });
  });
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
    const tried = await run(bwrap, [
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
      truePath,
    ]);
    if (tried.code !== 0) {
      return {
        available: false,
        kind,
        reason: `bwrap cannot create its namespaces here (${tried.stderr.trim()}): unprivileged user namespaces may be disabled (kernel.unprivileged_userns_clone, kernel.apparmor_restrict_unprivileged_userns) or the process runs in a container that forbids them`,
      };
    }
    return { available: true, kind, bwrap, socat };
  }
  return {
    available: false,
    reason: `the OS sandbox runs on macOS and Linux, not on ${platform}`,
  };
}
