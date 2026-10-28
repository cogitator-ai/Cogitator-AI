import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_SYMLINK_HOPS = 40;

/**
 * An entry of a filesystem list, resolved: an absolute path, and the regular expression it
 * stands for when it holds wildcards (`*`, `?`, `**`, `[...]`)
 */
export interface PolicyPath {
  /** The entry as the policy wrote it */
  entry: string;
  /** Absolute, with `~` expanded, `/**` and trailing slashes taken off */
  path: string;
  /** For a wildcard entry: the expression over absolute paths, matching what is under a match too */
  pattern?: RegExp;
  /** For a wildcard entry: the longest directory before the first wildcard */
  base?: string;
}

/** Whether an entry holds a wildcard of the sandbox path syntax */
export function hasWildcard(path: string): boolean {
  return /[*?[]/.test(path);
}

/**
 * Reads a filesystem entry: `~` and `~/x` from the home directory, `//x` and `/x` absolute,
 * anything else relative to `base`. A trailing `/**` covers the same directory as the path
 * without it, a trailing slash is dropped
 */
export function resolvePolicyPath(entry: string, base: string, home = homedir()): PolicyPath {
  let text = entry.trim();
  if (text.startsWith('//')) text = text.slice(1);
  if (text === '~') text = home;
  else if (text.startsWith('~/')) text = join(home, text.slice(2));
  while (text.endsWith('/**') && text.length > 3) text = text.slice(0, -3);
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1);
  const path = isAbsolute(text) ? resolve(text) : resolve(base, text);
  if (!hasWildcard(path)) return { entry, path };
  const literal = path.split('/');
  const firstWild = literal.findIndex((part) => hasWildcard(part));
  const baseDir = literal.slice(0, firstWild).join('/') || '/';
  return { entry, path, pattern: globRegExp(path), base: baseDir };
}

/**
 * `glob` (an absolute path with wildcards) as a regular expression over absolute paths that
 * also matches what lies under a match: `*` and `?` stay within one name, `**` spans names,
 * `[abc]` is one character of a set (brackets that spell no set are literal)
 */
export function globRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}(?:/.*)?$`);
}

/**
 * The regular expression source of a glob, without anchors: for JavaScript, or in the POSIX
 * extended syntax a Seatbelt profile takes (plain groups only)
 */
export function globSource(glob: string, flavor: 'js' | 'posix' = 'js'): string {
  const group = flavor === 'js' ? '(?:' : '(';
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += `${group}.*/)?`;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = glob.indexOf(']', i + 2);
      const body = close === -1 ? '' : glob.slice(i + 1, close);
      if (close !== -1 && validClass(body)) {
        const negated = body.startsWith('!') || body.startsWith('^');
        const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, (c) => `\\${c}`);
        out += negated ? `[^/${members}]` : `[${members}]`;
        i = close;
        continue;
      }
    }
    out += escapeRegExp(char);
  }
  return out;
}

/** Whether the text between brackets spells a set: not empty, every range running forward */
function validClass(body: string): boolean {
  const members = body.startsWith('!') || body.startsWith('^') ? body.slice(1) : body;
  if (members.length === 0 || members.includes('/')) return false;
  for (let i = 1; i < members.length - 1; i++) {
    if (members[i] === '-' && members.charCodeAt(i - 1) > members.charCodeAt(i + 1)) return false;
  }
  return true;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
}

/** How deep a path is: the number of its names */
export function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/** Whether `path` is `dir` or lies under it */
export function isWithin(dir: string, path: string): boolean {
  if (path === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return path.startsWith(prefix);
}

/**
 * `path` with every symlink resolved, a dangling one too, and what does not exist kept as it is
 * after the real path of its nearest existing ancestor: where a write to it would land
 */
export async function canonicalPath(path: string): Promise<string> {
  return canonicalFrom(resolve(path), 0);
}

async function canonicalFrom(path: string, hops: number): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) return path;
  const real = await realpath(path).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = dirname(path);
  if (parent === path) return path;
  const here = join(await canonicalFrom(parent, hops), basename(path));
  const info = await lstat(here).catch(() => undefined);
  if (!info?.isSymbolicLink()) return here;
  const target = await readlink(here).catch(() => undefined);
  if (target === undefined) return here;
  return canonicalFrom(resolve(dirname(here), target), hops + 1);
}

/**
 * The names a path has: as written (what a command reaches once it replaces a symlinked parent
 * with a real directory), with its parent resolved (the link itself when it is one), and fully
 * resolved (where a symlink leads). All are denied, so no name reaches it
 */
export async function namesOf(path: string): Promise<string[]> {
  const written = resolve(path);
  const parent = await canonicalPath(dirname(written));
  const lexical = join(parent, basename(written));
  const real = await canonicalPath(written);
  return [...new Set([lexical, real, written])];
}

/** What exists at `path`, without following a final symlink */
export async function kindOf(path: string): Promise<'file' | 'directory' | 'symlink' | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return 'symlink';
  return info.isDirectory() ? 'directory' : 'file';
}

/** The most entries a wildcard expansion looks at before it gives up and denies its base */
const MAX_EXPANSION_VISITS = 20_000;

/**
 * The existing paths a wildcard entry matches, for bubblewrap, which can only mount concrete
 * paths: the tree under its base walked (symlinked directories not entered), each match kept
 * and not descended. `truncated` when the walk gave up before the end
 */
export async function expandWildcard(
  entry: PolicyPath
): Promise<{ matches: string[]; truncated: boolean }> {
  const pattern = entry.pattern;
  if (!pattern || !entry.base) return { matches: [entry.path], truncated: false };
  const exact = new RegExp(`^${globSource(entry.path)}$`);
  const matches: string[] = [];
  const queue = [entry.base];
  let visits = 0;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const dirent of names) {
      if (++visits > MAX_EXPANSION_VISITS) return { matches, truncated: true };
      const full = join(dir, dirent.name);
      if (exact.test(full)) {
        matches.push(full);
        continue;
      }
      if (dirent.isDirectory()) queue.push(full);
    }
  }
  return { matches, truncated: false };
}
