import { WorkspaceError } from '@cogitator-ai/types';

/**
 * `value` as one word of a POSIX shell command line, in single quotes, with every single quote
 * closed, escaped and reopened. Nothing inside single quotes is special to `sh` or `bash`
 * (`$`, backquotes, globs, newlines, a leading dash), so the word reaches the program as it is.
 * A NUL byte cannot be passed in an argument at all and is refused.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0')) {
    throw new WorkspaceError('INVALID_PATH', 'A shell argument cannot contain a NUL byte');
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `argv` as a shell command line that runs the program with exactly these arguments. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/** Whether `name` can be an environment variable name a shell accepts in `NAME=value`. */
export function isEnvName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    const digit = code >= 48 && code <= 57;
    if (!letter && !(digit && i > 0)) return false;
  }
  return true;
}
