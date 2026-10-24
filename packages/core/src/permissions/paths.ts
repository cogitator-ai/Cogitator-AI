/**
 * Path patterns of `Read(...)` and `Edit(...)` rules, in the gitignore syntax Claude Code reads
 * them with: `//abs`, `~/home`, `/from-the-settings`, `relative` and `./relative`
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import type { PermissionBehavior } from '@cogitator-ai/types';
import { resolveReal } from '../tools/path-guard';

/** Where the parts of a path pattern start from */
export interface PathAnchors {
  /** The directory `relative` and `./relative` patterns start from: the working directory */
  cwd: string;
  /** The directory `/path` patterns start from: the project root, or the settings directory */
  source: string;
  /** The home directory of `~/path` patterns (default the user's) */
  home?: string;
}

/** A path pattern read, see {@link compilePathPattern} */
export interface PathPattern {
  /** Whether it is a `!` pattern, which carves paths out of the rules before it */
  negated: boolean;
  /** Whether it starts from the working directory (the patterns a `!` pattern can carve from) */
  relative: boolean;
  /** Its segments from the file system root: `**` for any number of directories, else a glob */
  segments: readonly string[];
}

const ESCAPABLE = new Set(['*', '?', '[', ']', '!', '#', '\\', ' ', '(', ')', '{', '}']);

/** `text` without the `/` characters at its end, in one pass */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end--;
  return text.slice(0, end);
}

/** A path as rules compare it: POSIX separators, a Windows drive as `/c/...` */
export function normalizeRulePath(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return posix.normalize(path);
  const resolved = win32.resolve(path);
  const hasDrive = /^[A-Za-z]:/.test(resolved);
  let rest = hasDrive ? resolved.slice(2) : resolved;
  if (rest.startsWith('\\') || rest.startsWith('/')) rest = rest.slice(1);
  rest = rest.split('\\').join('/');
  return posix.normalize(hasDrive ? `/${resolved[0].toLowerCase()}/${rest}` : `/${rest}`);
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Reads the path pattern of a rule for `behavior`. A bare name (no `/` but a trailing one) matches
 * at any depth below its start, and so does a relative pattern of one directory and `/**` in a
 * `deny` or `ask` rule, every other pattern only where it starts. A path matches a pattern when it
 * or one of its parents does, so a pattern of a directory covers what it holds
 *
 * @returns the pattern, or why it is not one (a backslash used as a path separator)
 */
export function compilePathPattern(
  spec: string,
  behavior: PermissionBehavior,
  anchors: PathAnchors
): PathPattern | { error: string } {
  let pattern = spec.trim();
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '\\') continue;
    if (!ESCAPABLE.has(pattern[i + 1] ?? '')) {
      return { error: `"${spec}" uses "\\" as a path separator, write paths with "/"` };
    }
    i++;
  }
  if (pattern === '' || pattern === '*' || pattern === '**') {
    return { negated, relative: true, segments: ['**'] };
  }
  let base: string;
  let rest: string;
  let relative = false;
  if (!negated && pattern.startsWith('//')) {
    base = '/';
    rest = pattern.slice(2);
  } else if (!negated && pattern.startsWith('~/')) {
    base = normalizeRulePath(anchors.home ?? homedir());
    rest = pattern.slice(2);
  } else if (!negated && pattern.startsWith('/')) {
    base = normalizeRulePath(anchors.source);
    rest = pattern.slice(1);
  } else {
    base = normalizeRulePath(anchors.cwd);
    relative = true;
    const explicit = pattern.startsWith('./');
    rest = explicit ? pattern.slice(2) : pattern;
    const trimmed = trimTrailingSlashes(rest);
    const segments = trimmed.split('/');
    if (!explicit && !trimmed.includes('/')) {
      rest = `**/${trimmed}`;
    } else if (
      !explicit &&
      behavior !== 'allow' &&
      segments.length === 2 &&
      segments[1] === '**' &&
      !/[*?[]/.test(segments[0])
    ) {
      rest = `**/${trimmed}`;
    }
  }
  const globs = segmentsOf(trimTrailingSlashes(rest));
  return { negated, relative, segments: [...segmentsOf(base).map(literalGlob), ...globs] };
}

/** A path segment as a glob that matches only itself */
function literalGlob(segment: string): string {
  let glob = '';
  for (const char of segment) glob += ESCAPABLE.has(char) ? `\\${char}` : char;
  return glob;
}

/** Whether a segment of a path matches a segment glob: `*`, `?`, `[...]`, `\` escapes */
function segmentMatches(glob: string, text: string): boolean {
  let g = 0;
  let t = 0;
  let starG = -1;
  let starT = 0;
  while (t < text.length) {
    if (g < glob.length) {
      const char = glob[g];
      if (char === '*') {
        starG = g++;
        starT = t;
        continue;
      }
      if (char === '?') {
        g++;
        t++;
        continue;
      }
      if (char === '[') {
        const end = glob.indexOf(']', g + 2);
        if (end !== -1) {
          const negated = glob[g + 1] === '!' || glob[g + 1] === '^';
          const body = glob.slice(negated ? g + 2 : g + 1, end);
          if (inClass(body, text[t]) !== negated) {
            g = end + 1;
            t++;
            continue;
          }
        } else if (text[t] === '[') {
          g++;
          t++;
          continue;
        }
      } else {
        const literal = char === '\\' && g + 1 < glob.length ? glob[g + 1] : char;
        if (literal === text[t]) {
          g += char === '\\' && g + 1 < glob.length ? 2 : 1;
          t++;
          continue;
        }
      }
    }
    if (starG === -1) return false;
    g = starG + 1;
    t = ++starT;
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

function inClass(body: string, char: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === '-' && i + 2 < body.length) {
      if (char >= body[i] && char <= body[i + 2]) return true;
      i += 2;
    } else if (body[i] === char) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the path segments from `p` and `t` on match: `**` takes any number of segments. Linear
 * in the product of the two lengths, no regex
 */
function segmentsMatch(
  pattern: readonly string[],
  path: readonly string[],
  prefixOnly: boolean
): boolean {
  const seen = new Set<number>();
  const visit = (p: number, t: number): boolean => {
    const key = p * (path.length + 1) + t;
    if (seen.has(key)) return false;
    seen.add(key);
    if (t === path.length) {
      if (prefixOnly) return p < pattern.length;
      return pattern.slice(p).every((segment) => segment === '**');
    }
    if (p === pattern.length) return false;
    if (pattern[p] === '**') return visit(p + 1, t) || visit(p, t + 1);
    return segmentMatches(pattern[p], path[t]) && visit(p + 1, t + 1);
  };
  return visit(0, 0);
}

/**
 * A path or a glob as rules compare it: Unicode in NFC, so a name written precomposed and one
 * written decomposed compare equal, and lowercase where the file system ignores case
 */
export function foldPath(text: string, ignoreCase: boolean): string {
  const composed = text.normalize('NFC');
  return ignoreCase ? composed.toLowerCase() : composed;
}

/**
 * Whether `path` (normalized, absolute) or one of its parents matches `pattern`, without case on
 * a file system that `ignoreCase` says ignores it
 */
export function pathMatches(
  pattern: PathPattern,
  path: string,
  ignoreCase = false
): 'self' | 'parent' | undefined {
  const globs = pattern.segments.map((segment) => foldPath(segment, ignoreCase));
  const segments = segmentsOf(foldPath(path, ignoreCase));
  if (segmentsMatch(globs, segments, false)) return 'self';
  for (let end = segments.length - 1; end >= 0; end--) {
    if (segmentsMatch(globs, segments.slice(0, end), false)) return 'parent';
  }
  return undefined;
}

/**
 * Whether something inside the directory `path` could match `pattern`, for a command that reads
 * a directory recursively: the pattern covers the directory, or goes on below it
 */
export function patternReachesInto(
  pattern: PathPattern,
  path: string,
  ignoreCase = false
): boolean {
  if (pathMatches(pattern, path, ignoreCase)) return true;
  return segmentsMatch(
    pattern.segments.map((segment) => foldPath(segment, ignoreCase)),
    segmentsOf(foldPath(path, ignoreCase)),
    true
  );
}

const caseProbes = new Map<string, Promise<boolean>>();

/**
 * Whether the file system `dir` lives on ignores the case of names (APFS and NTFS by default),
 * probed once per directory: the nearest name with letters in it is looked up with its case
 * flipped. When the probe cannot tell, macOS and Windows count as ignoring case
 */
export function pathsIgnoreCase(
  dir: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const key = resolve(dir);
  let probe = caseProbes.get(key);
  if (!probe) {
    probe = probeCase(key, platform === 'darwin' || platform === 'win32');
    caseProbes.set(key, probe);
  }
  return probe;
}

async function probeCase(dir: string, fallback: boolean): Promise<boolean> {
  let current = dir;
  for (;;) {
    const name = basename(current);
    const flipped = flipCase(name);
    if (flipped !== name) {
      const own = await stat(current).catch(() => undefined);
      if (!own) return fallback;
      try {
        const other = await stat(join(dirname(current), flipped));
        return other.dev === own.dev && other.ino === own.ino;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : fallback;
      }
    }
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

/** `name` with the case of its ASCII letters flipped, whose flip every file system maps back */
function flipCase(name: string): string {
  let flipped = '';
  for (const char of name) {
    if (char >= 'a' && char <= 'z') flipped += char.toUpperCase();
    else if (char >= 'A' && char <= 'Z') flipped += char.toLowerCase();
    else flipped += char;
  }
  return flipped;
}

/** The paths a rule compares for a call's path: as the call names it, and with symlinks followed */
export interface ResolvedPath {
  /** The path made absolute, `..` taken out, symlinks not followed */
  requested: string;
  /** The path with every symlink followed, also for a file that does not exist yet */
  real: string;
}

/** {@link ResolvedPath} of `path`, relative to `base` unless absolute */
export async function resolveCallPath(path: string, base: string): Promise<ResolvedPath> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  return {
    requested: normalizeRulePath(absolute),
    real: normalizeRulePath(await resolveReal(absolute)),
  };
}
