import type { WorkspaceExecResult, WorkspaceLaunchRequest } from '@cogitator-ai/types';
import type { OsSandbox } from '../../os/os-sandbox';
import { runChild } from '../../utils/run-child';

/** Runs `command` in `root` through the sandbox, as a `LocalWorkspace` would, the report merged */
export async function runSandboxed(
  sandbox: OsSandbox,
  root: string,
  command: string,
  request: WorkspaceLaunchRequest = {},
  env: Record<string, string> = {}
): Promise<WorkspaceExecResult> {
  const baseEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    ...env,
  };
  const launch = await sandbox.launch({
    file: '/bin/sh',
    args: ['-c', command],
    cwd: root,
    env: baseEnv,
    root,
    command,
    request,
  });
  let result: WorkspaceExecResult | undefined;
  try {
    const run = await runChild({
      file: launch.file,
      args: launch.args,
      cwd: root,
      env: launch.env ?? baseEnv,
      timeout: 30_000,
      maxOutput: 1024 * 1024,
    });
    if ('aborted' in run) throw new Error('aborted');
    result = {
      stdout: run.result.stdout,
      stderr: run.result.stderr,
      exitCode: run.result.exitCode,
      timedOut: run.result.timedOut,
      truncated: false,
      durationMs: run.result.duration,
    };
  } finally {
    const report = await launch.cleanup?.(result);
    if (result && report) {
      if (report.notice) result.stderr = `${result.stderr}${report.notice}`;
      if (report.sandbox) result.sandbox = report.sandbox;
    }
  }
  return result;
}
