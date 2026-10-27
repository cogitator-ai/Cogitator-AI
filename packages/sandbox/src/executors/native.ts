/**
 * Native sandbox executor - no isolation, runs directly on host.
 * Used as fallback when Docker is unavailable.
 *
 * A single-element command is run through the system shell; longer commands are
 * executed directly with exact argv (no shell), matching the Docker executor.
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator-ai/types';
import { BaseSandboxExecutor } from './base';
import { runChild } from '../utils/run-child';
import { abortMessage } from '../utils/abort';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_SIZE = 50_000;

export const INHERITED_ENV_KEYS = [
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

export function baseEnvironment(): Record<string, string> {
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

    if (request.signal?.aborted) {
      return this.failure(abortMessage(request.signal));
    }

    const [file, ...args] = request.command;
    const run = await runChild({
      file,
      args,
      cwd: request.cwd ?? config.workdir,
      env: { ...baseEnvironment(), ...config.env, ...request.env },
      shell: request.command.length === 1,
      stdin: request.stdin,
      timeout: request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT,
      maxOutput: MAX_OUTPUT_SIZE,
      signal: request.signal,
    });
    return 'aborted' in run
      ? this.failure(abortMessage(request.signal!))
      : this.success(run.result);
  }
}
