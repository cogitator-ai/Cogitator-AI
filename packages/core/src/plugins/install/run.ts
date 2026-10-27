/**
 * Running the tools an install needs (`git`, `npm`, `tar`) without a shell, with a timeout, and
 * reading what they print
 */

import { spawn } from 'node:child_process';
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
  /** Run it through the system shell: only for a command a person accepted, never for data */
  shell?: boolean;
  signal?: AbortSignal;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** A failed run of an install tool, typed `Error` for the promise it rejects */
function installFailure(message: string): Error {
  return new CogitatorError({ message, code: ErrorCode.PLUGIN_INSTALL_FAILED });
}

/** The characters `cmd.exe` reads as its own syntax, escaped with `^` */
const CMD_META = new Set([
  '(',
  ')',
  '[',
  ']',
  '%',
  '!',
  '^',
  '"',
  '`',
  '<',
  '>',
  '&',
  '|',
  ';',
  ',',
  ' ',
  '*',
  '?',
]);

function caretEscaped(text: string): string {
  let out = '';
  for (const char of text) out += CMD_META.has(char) ? `^${char}` : char;
  return out;
}

/**
 * `arg` as one argument of a `cmd.exe /c` line that runs a `.cmd` shim: quoted the way the C
 * runtime splits arguments (backslashes before a quote doubled), then every `cmd.exe` meta
 * character escaped twice, once for `cmd.exe` and once for the batch file it starts. Nothing in
 * `arg` can end the argument or start another command
 */
export function cmdArgument(arg: string): string {
  let quoted = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      slashes++;
      continue;
    }
    quoted += char === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${char}`;
    slashes = 0;
  }
  quoted += `${'\\'.repeat(slashes * 2)}"`;
  return caretEscaped(caretEscaped(quoted));
}

/**
 * How to start `file` with `args`: as it is, or, for a `.cmd` or `.bat` file on Windows (which
 * only `cmd.exe` runs), through `cmd.exe` with every argument escaped by {@link cmdArgument},
 * never through a shell that would read the arguments as commands
 */
function launchOf(
  file: string,
  args: readonly string[],
  shell: boolean
): { file: string; args: string[]; verbatim: boolean; shell: boolean } {
  if (shell || process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) {
    return { file, args: [...args], verbatim: false, shell };
  }
  const line = [caretEscaped(file), ...args.map(cmdArgument)].join(' ');
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true, shell: false };
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
    const launch = launchOf(file, args, options.shell === true);
    const child = spawn(launch.file, launch.args, {
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
      windowsVerbatimArguments: launch.verbatim,
      shell: launch.shell,
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

/** The npm client of the platform */
export function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
