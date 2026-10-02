/**
 * Native sandbox executor - no isolation, runs directly on host.
 * Used as fallback when Docker is unavailable.
 *
 * A single-element command is run through the system shell; longer commands are
 * executed directly with exact argv (no shell), matching the Docker executor.
 */

import { spawn } from 'node:child_process';
import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator-ai/types';
import { BaseSandboxExecutor } from './base';
import { OutputCollector } from '../utils/output-collector';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_SIZE = 50_000;

const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
];

function baseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export class NativeSandboxExecutor extends BaseSandboxExecutor {
  readonly type = 'native';

  async connect(): Promise<SandboxResult<void>> {
    return this.success(undefined);
  }

  async disconnect(): Promise<SandboxResult<void>> {
    return this.success(undefined);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    if (!request.command || request.command.length === 0) {
      return this.failure('Command array is empty');
    }

    const [file, ...args] = request.command;
    const useShell = request.command.length === 1;
    const startTime = Date.now();
    const timeout = request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
    const stdout = new OutputCollector(MAX_OUTPUT_SIZE);
    const stderr = new OutputCollector(MAX_OUTPUT_SIZE);

    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number, extraStderr?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (extraStderr) stderr.push(extraStderr);
        resolve(
          this.success({
            stdout: stdout.toString(),
            stderr: timedOut
              ? stderr.toString() || `Command timed out after ${timeout}ms`
              : stderr.toString(),
            exitCode: timedOut ? 124 : exitCode,
            timedOut,
            duration: Date.now() - startTime,
          })
        );
      };

      const useProcessGroup = process.platform !== 'win32';
      const child = spawn(file, args, {
        cwd: request.cwd ?? config.workdir,
        env: { ...baseEnvironment(), ...config.env, ...request.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: useProcessGroup,
        shell: useShell,
      });

      const timer = setTimeout(() => {
        timedOut = true;
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
        finish(124);
      }, timeout);

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
      child.stdin.end(request.stdin ?? '');
    });
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
