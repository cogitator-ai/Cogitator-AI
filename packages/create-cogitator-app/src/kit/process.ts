import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  output: string;
}

/** The last `lines` lines of `text`, for error messages that show why a command failed. */
export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Runs `command` without a shell. Output is captured, or shown live with
 * `inherit`. Resolves with the exit code instead of throwing, and rejects only
 * when the command cannot be started at all.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; inherit?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      timeout: options.timeoutMs,
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 1), output });
    });
  });
}

/** Whether `command` can be run, judged by `<command> --version`. */
export async function hasCommand(command: string, cwd = process.cwd()): Promise<boolean> {
  try {
    return (await runCommand(command, ['--version'], { cwd, timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}
