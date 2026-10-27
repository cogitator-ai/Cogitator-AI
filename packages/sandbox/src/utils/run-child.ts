import { spawn } from 'node:child_process';
import type { SandboxExecutionResult } from '@cogitator-ai/types';
import { OutputCollector } from './output-collector';

export interface RunChildOptions {
  file: string;
  args: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  /** Run `file` through the system shell (a single-string command) */
  shell?: boolean;
  stdin?: string;
  timeout: number;
  maxOutput: number;
  signal?: AbortSignal;
}

/**
 * Runs a process in a group of its own (outside Windows), its output collected up to a limit,
 * the group killed on a timeout or an abort. Resolves with the result, or `aborted` when the
 * signal stopped it
 */
export function runChild(
  options: RunChildOptions
): Promise<{ result: SandboxExecutionResult } | { aborted: true }> {
  const startTime = Date.now();
  const stdout = new OutputCollector(options.maxOutput);
  const stderr = new OutputCollector(options.maxOutput);
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (extraStderr) stderr.push(extraStderr);
      resolve({
        result: {
          stdout: stdout.toString(),
          stderr: timedOut
            ? stderr.toString() || `Command timed out after ${options.timeout}ms`
            : stderr.toString(),
          exitCode: timedOut ? 124 : exitCode,
          timedOut,
          duration: Date.now() - startTime,
        },
      });
    };

    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: useProcessGroup,
      shell: options.shell === true,
    });

    const kill = () => {
      try {
        if (useProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(124);
    }, options.timeout);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      resolve({ aborted: true });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      const exitCode = error.code === 'ENOENT' ? 127 : error.code === 'EACCES' ? 126 : 1;
      finish(exitCode, error.message);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
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
