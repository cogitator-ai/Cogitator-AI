/**
 * Running the tools an install needs (`git`, `npm`, `tar`) without a shell, with a timeout, and
 * reading what they print
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** How a command ended */
export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Options of {@link runTool} */
export interface ToolOptions {
  cwd?: string;
  /** Variables on top of the process's environment */
  env?: Readonly<Record<string, string>>;
  /** Milliseconds before the command is killed (default 120 000) */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** A failed run of an install tool, typed `Error` for the promise it rejects */
function installFailure(message: string): Error {
  return new CogitatorError({ message, code: ErrorCode.PLUGIN_INSTALL_FAILED });
}

/**
 * Runs `file` with `args`, failing only when it cannot start or is killed by the timeout or the
 * signal. A kill reaches what the command started too: its process group on POSIX, its process
 * tree on Windows
 */
export function runTool(
  file: string,
  args: readonly string[],
  options: ToolOptions = {}
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(file, [...args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: !windows,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const kill = () => {
      if (killed) return;
      killed = true;
      killTree(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = setTimeout(kill, timeoutMs);
    const onAbort = kill;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        installFailure(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `${file} is not installed or not on PATH`
            : `${file} could not start: ${error.message}`
        )
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (killed) {
        reject(
          installFailure(
            options.signal?.aborted
              ? `${file} was stopped`
              : `${file} ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s`
          )
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Kills the process `pid` and what it started: its process group on POSIX (it was spawned
 * detached, so it leads one), `taskkill /T` on Windows. `fallback` kills the process alone when
 * that fails
 */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return fallback();
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.on('error', fallback);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

/** Runs `file` and throws `PLUGIN_INSTALL_FAILED` with its error output unless it exits 0 */
export async function mustRun(
  file: string,
  args: readonly string[],
  options: ToolOptions = {}
): Promise<string> {
  const result = await runTool(file, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' ') || result.stdout.trim();
    throw new CogitatorError({
      message: `${file} ${args.slice(0, 2).join(' ')} failed${detail ? `: ${detail}` : ''}`,
      code: ErrorCode.PLUGIN_INSTALL_FAILED,
    });
  }
  return result.stdout;
}

/** How npm is started: a program and the arguments before npm's own */
export interface NpmInvocation {
  file: string;
  args: string[];
}

/**
 * How to start npm without a shell: `npm` on POSIX, and on Windows (where `npm` is a `.cmd`
 * shim only `cmd.exe` runs) node itself with npm's `npm-cli.js`, from `npm_execpath` when it
 * names one, else the npm that came with this node. Without one the install fails: npm never
 * runs through `cmd.exe`, which would read its arguments as commands
 */
export function npmInvocation(
  host: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    execPath: string;
    exists: (path: string) => boolean;
  } = {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    exists: existsSync,
  }
): NpmInvocation {
  if (host.platform !== 'win32') return { file: 'npm', args: [] };
  const named = host.env.npm_execpath;
  const candidates = [
    ...(named && /npm-cli\.js$/i.test(named) ? [named] : []),
    win32.join(win32.dirname(host.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((path) => host.exists(path));
  if (!cli) {
    throw installFailure(
      `npm-cli.js was not found next to ${host.execPath}: install npm with node, or set npm_execpath to its npm-cli.js`
    );
  }
  return { file: host.execPath, args: [cli] };
}

/** Runs npm with `args` (see {@link npmInvocation}), as {@link runTool} runs a tool */
export function runNpm(args: readonly string[], options: ToolOptions = {}): Promise<ToolResult> {
  const npm = npmInvocation();
  return runTool(npm.file, [...npm.args, ...args], options);
}

/** Runs npm with `args` and throws its error output unless it exits 0, as {@link mustRun} */
export function mustRunNpm(args: readonly string[], options: ToolOptions = {}): Promise<string> {
  const npm = npmInvocation();
  return mustRun(npm.file, [...npm.args, ...args], options);
}

/**
 * Runs `command` through the system shell (`/bin/sh -c`, `cmd.exe /d /s /c` on Windows). Only
 * for the command of a `command` plugin source, which a person read and accepted as it is: no
 * other caller may hand data to a shell
 */
export function runAcceptedShellCommand(
  command: string,
  options: ToolOptions = {}
): Promise<ToolResult> {
  return process.platform === 'win32'
    ? runTool('cmd.exe', ['/d', '/s', '/c', command], options)
    : runTool('/bin/sh', ['-c', command], options);
}
