import { execSync, type ExecSyncOptions } from 'node:child_process';

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export function exec(command: string, options?: ExecSyncOptions): ExecResult {
  try {
    const output = execSync(command, {
      stdio: 'pipe',
      ...options,
      encoding: 'utf-8',
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    const error = err as Error & { stderr?: string };
    return {
      success: false,
      output: '',
      error: error.stderr?.trim() ?? error.message,
    };
  }
}

export function isCommandAvailable(command: string): boolean {
  const check = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
  return exec(check).success;
}
