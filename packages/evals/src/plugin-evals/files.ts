import { statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is `root` or below it, both absolute */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `path` as a relative path of plain directory names (`qa`, `./quality/evals`), with `.`
 * segments dropped, or why it is not one: absolute, holding `..`, or empty
 */
export function plainRelativePath(path: string): { path: string } | { problem: string } {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]/.test(path)) {
    return { problem: 'is absolute' };
  }
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return { problem: 'contains ..' };
  if (segments.length === 0) return { problem: 'is empty' };
  return { path: segments.join('/') };
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `path` with forward slashes, as graders and reports show workspace paths */
export function posixPath(path: string): string {
  return path.split(sep).join('/');
}
