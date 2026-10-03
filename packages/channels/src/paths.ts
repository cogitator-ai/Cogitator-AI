import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` (alone or followed by a path separator) to the user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}
