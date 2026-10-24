/**
 * Path patterns of `Read(...)` and `Edit(...)` rules, in the gitignore syntax Claude Code reads
 * them with: `//abs`, `~/home`, `/from-the-settings`, `relative` and `./relative`
 */

import { homedir } from 'node:os';
import { isAbsolute, posix, resolve, win32 } from 'node:path';
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
  regex: RegExp;
}

const ESCAPABLE = new Set(['*', '?', '[', ']', '!', '#', '\\', ' ', '(', ')', '{', '}']);

/** A path as rules compare it: POSIX separators, a Windows drive as `/c/...` */
export function normalizeRulePath(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return posix.normalize(path);
  const resolved = win32.resolve(path);
  const drive = /^([A-Za-z]):[\\/]?/.exec(resolved);
  const rest = resolved.replace(/^[A-Za-z]:[\\/]?/, '').replace(/\\/g, '/');
  return posix.normalize(drive ? `/${drive[1].toLowerCase()}/${rest}` : `/${rest}`);
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
    return { negated, relative: true, regex: /^[\s\S]*$/ };
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
    const trimmed = rest.replace(/\/+$/, '');
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
  rest = rest.replace(/\/+$/, '');
  const prefix = base === '/' ? '' : base.replace(/\/+$/, '');
  return { negated, relative, regex: new RegExp(`^${escapeRegex(prefix)}/${globSource(rest)}$`) };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The regex source of a gitignore glob: `**` across directories, `*` and `?` within one */
function globSource(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '\\' && i + 1 < glob.length) {
      source += escapeRegex(glob[i + 1]);
      i++;
    } else if (char === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
      if (atStart && atEnd) {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '[\\s\\S]*';
          i += 1;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        source += '\\[';
      } else {
        const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
}

/** Whether `path` (normalized, absolute) or one of its parents matches `pattern` */
export function pathMatches(pattern: PathPattern, path: string): 'self' | 'parent' | undefined {
  if (pattern.regex.test(path)) return 'self';
  let current = path;
  for (;;) {
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    if (pattern.regex.test(parent)) return 'parent';
    current = parent;
  }
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
