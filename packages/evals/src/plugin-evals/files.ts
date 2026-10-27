import { statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is `root` or below it, both absolute */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why `path` is not a relative path of plain directory names (`qa`, `quality/evals`),
 * undefined when it is one
 */
export function plainRelativeProblem(path: string): string | undefined {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return 'is absolute';
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  if (segments.length === 0) return 'is empty';
  if (segments.some((segment) => segment === '..')) return 'contains ..';
  if (segments.some((segment) => segment === '.')) return 'contains .';
  return undefined;
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
