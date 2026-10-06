import path from 'node:path';

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_LENGTH = 214;

/**
 * Why `name` cannot be the generated package's name, or `undefined` when it can.
 * The name lands in package.json and in generated code, so it has to be a valid
 * unscoped npm package name.
 */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Project name is required';
  if (trimmed.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters`;
  if (!PACKAGE_NAME.test(trimmed)) {
    return 'Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit';
  }
  return undefined;
}

/** The package name for a project created in `dir`: its last path segment, so `.` names it after the current directory. */
export function projectNameFromDirectory(dir: string, cwd: string = process.cwd()): string {
  return path.basename(path.resolve(cwd, dir.trim()));
}
