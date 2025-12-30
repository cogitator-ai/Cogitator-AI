/**
 * Native sandbox executor - no isolation, runs directly on host.
 * Used as fallback when Docker is unavailable.
 */

import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator/types';
import { BaseSandboxExecutor } from './base.js';

const execPromise = promisify(execCallback);

const MAX_OUTPUT_SIZE = 50_000;
const MAX_BUFFER = 10 * 1024 * 1024;

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
    const startTime = Date.now();
    const timeout = request.timeout ?? config.timeout ?? 30_000;

    try {
      const command = request.command.join(' ');
      const { stdout, stderr } = await execPromise(command, {
        cwd: request.cwd ?? config.workdir,
        timeout,
        env: { ...process.env, ...config.env, ...request.env },
        maxBuffer: MAX_BUFFER,
      });

      return this.success({
        stdout: stdout.slice(0, MAX_OUTPUT_SIZE),
        stderr: stderr.slice(0, MAX_OUTPUT_SIZE),
        exitCode: 0,
        timedOut: false,
        duration: Date.now() - startTime,
      });
    } catch (err) {
      const error = err as Error & {
        code?: number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };

      if (error.killed) {
        return this.success({
          stdout: '',
          stderr: `Command timed out after ${timeout.toString()}ms`,
          exitCode: 124,
          timedOut: true,
          duration: Date.now() - startTime,
        });
      }

      return this.success({
        stdout: (error.stdout ?? '').slice(0, MAX_OUTPUT_SIZE),
        stderr: (error.stderr ?? error.message).slice(0, MAX_OUTPUT_SIZE),
        exitCode: error.code ?? 1,
        timedOut: false,
        duration: Date.now() - startTime,
      });
    }
  }
}
