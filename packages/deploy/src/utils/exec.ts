import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

function errorText(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const stderr = 'stderr' in err ? err.stderr : undefined;
  const text =
    typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : '';
  if (text.trim()) return text.trim();
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a command without a shell. Arguments are passed verbatim, so paths with
 * spaces and user-provided values cannot be interpreted by a shell.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): ExecResult {
  try {
    const output = execFileSync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeout,
      input: options.input,
      env: options.env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return { success: false, output: '', error: errorText(err) };
  }
}

function executableCandidates(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...extensions.map((ext) => `${command}${ext.toLowerCase()}`)];
}

/**
 * Check whether an executable is resolvable on PATH without spawning a process.
 */
export function isCommandAvailable(command: string, pathEnv = process.env.PATH ?? ''): boolean {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const candidate of executableCandidates(command)) {
      try {
        const full = join(dir, candidate);
        accessSync(full, mode);
        if (statSync(full).isFile()) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
