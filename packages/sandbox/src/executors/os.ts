/**
 * OS sandbox executor: runs a command on the host under Seatbelt (macOS) or bubblewrap (Linux),
 * confined by the `os` policy of its config. There is no fallback: a machine without the sandbox
 * fails the execution
 */

import type {
  OsSandboxPolicy,
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
  WorkspaceLaunchOverride,
} from '@cogitator-ai/types';
import { BaseSandboxExecutor } from './base';
import { baseEnvironment } from './native';
import { OsSandbox } from '../os/os-sandbox';
import { abortMessage } from '../utils/abort';
import { runChild } from '../utils/run-child';
import { shellCommand } from '../workspace/remote/shell-quote';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_SIZE = 50_000;

export interface OsExecutorOptions {
  /** Hears what the sandboxes warn about (default: `console.warn`) */
  onWarning?: (message: string) => void;
}

export class OsSandboxExecutor extends BaseSandboxExecutor {
  readonly type = 'os';
  private readonly sandboxes = new Map<string, OsSandbox>();

  constructor(private readonly options: OsExecutorOptions = {}) {
    super();
  }

  async connect(): Promise<SandboxResult<void>> {
    return this.success(undefined);
  }

  async disconnect(): Promise<SandboxResult<void>> {
    const sandboxes = [...this.sandboxes.values()];
    this.sandboxes.clear();
    await Promise.all(sandboxes.map((sandbox) => sandbox.dispose()));
    return this.success(undefined);
  }

  async isAvailable(): Promise<boolean> {
    return (await OsSandbox.probe()).available;
  }

  private sandboxFor(policy: OsSandboxPolicy): OsSandbox {
    const key = JSON.stringify(policy);
    let sandbox = this.sandboxes.get(key);
    if (!sandbox) {
      sandbox = new OsSandbox({
        policy,
        ...(this.options.onWarning && { onWarning: this.options.onWarning }),
      });
      this.sandboxes.set(key, sandbox);
    }
    return sandbox;
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    if (!request.command || request.command.length === 0) {
      return this.failure('Command array is empty');
    }
    if (request.signal?.aborted) return this.failure(abortMessage(request.signal));
    const policy = config.os ?? {};
    if (policy.enabled === false) {
      return this.failure('The os sandbox policy is disabled (enabled: false): refusing to run');
    }
    let sandbox: OsSandbox;
    try {
      sandbox = this.sandboxFor(policy);
      await sandbox.start();
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }

    const cwd = request.cwd ?? config.workdir ?? process.cwd();
    const root = config.workdir ?? cwd;
    const single = request.command.length === 1;
    const [first, ...rest] = request.command;
    const env = { ...baseEnvironment(), ...config.env, ...request.env };
    let launch: WorkspaceLaunchOverride;
    try {
      launch = await sandbox.launch({
        file: single ? '/bin/sh' : first,
        args: single ? ['-c', first] : rest,
        cwd,
        env,
        root,
        command: single ? first : shellCommand(request.command),
        request: {},
      });
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
    let run: Awaited<ReturnType<typeof runChild>> | undefined;
    try {
      run = await runChild({
        file: launch.file,
        args: launch.args,
        cwd,
        env: launch.env ?? env,
        stdin: request.stdin,
        timeout: request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT,
        maxOutput: MAX_OUTPUT_SIZE,
        signal: request.signal,
      });
    } finally {
      const outcome = run && 'result' in run ? run.result : undefined;
      const report = await launch.cleanup?.(
        outcome && {
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          truncated: false,
          durationMs: outcome.duration,
        }
      );
      if (outcome && report?.notice) {
        outcome.stderr = outcome.stderr ? `${outcome.stderr}\n${report.notice}` : report.notice;
      }
    }
    if (!run || 'aborted' in run) return this.failure(abortMessage(request.signal!));
    return this.success(run.result);
  }
}
