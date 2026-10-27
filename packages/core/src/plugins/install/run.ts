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

/** Runs `file` with `args`, failing only when it cannot start or is killed by the timeout */
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
      shell: options.shell === true || (windows && /\.(cmd|bat)$/i.test(file)),
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
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
