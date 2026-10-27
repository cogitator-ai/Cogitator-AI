/**
 * How the permission engine treats commands the workspace runs in its OS sandbox, and the
 * removals that ask in every mode: `rm` and `rmdir` of a critical path, and removals outside the
 * workspace by a command that runs without the sandbox
 */

import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Workspace, WorkspaceSandbox, WorkspaceSandboxRoute } from '@cogitator-ai/types';
import type { ParsedCommandLine, ShellCommand } from './shell';

/** How a command call runs with respect to the workspace's sandbox */
export interface SandboxedCall {
  sandbox: WorkspaceSandbox;
  route: WorkspaceSandboxRoute;
  /** Whether the call names hosts of its own (`allowedDomains`) */
  domains: boolean;
}

/** The sandbox route of a command call, undefined for a workspace without a sandbox */
export async function sandboxedCall(
  workspace: Workspace | undefined,
  text: string,
  values: Record<string, unknown>
): Promise<SandboxedCall | undefined> {
  const sandbox = workspace?.sandbox;
  if (!sandbox) return undefined;
  try {
    const route = await sandbox.route(text, {
      dangerouslyDisableSandbox: values.dangerouslyDisableSandbox === true,
    });
    const domains = Array.isArray(values.allowedDomains) && values.allowedDomains.length > 0;
    return { sandbox, route, domains };
  } catch {
    return undefined;
  }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAKES = new Set(['make', 'gmake', 'bmake', 'pmake']);

/**
 * Whether the sandbox may allow the command line without asking: no variable set in front of a
 * command (`FOO=bar npm test`, `env FOO=bar ...`), no `eval`, no `make` with a variable
 * (`make CC=clang`), any of which can change which program runs
 */
export function plainForSandbox(line: ParsedCommandLine): boolean {
  return line.candidates.every((command) => {
    const program = command.argv[0] ?? '';
    if (command.assigned.length > 0 || program === 'eval') return false;
    return !(
      MAKES.has(basename(program)) && command.argv.slice(1).some((word) => ASSIGNMENT.test(word))
    );
  });
}

const REMOVERS = new Set(['rm', 'rmdir', 'unlink']);

/** An operand of a removal: its absolute path, or undefined when the shell decides it */
interface RemovalTarget {
  word: string;
  path?: string;
  /**
   * For a wildcard operand: the directory it lists, and whether a name there could be `.git` (a
   * shell wildcard matches a dot file only when its pattern starts with a dot)
   */
  glob?: { base: string; matchesGit: boolean };
}

/** The operands of the `rm`, `rmdir` and `unlink` commands of a line, resolved from `cwd` */
function removalTargets(line: ParsedCommandLine, cwd: string): RemovalTarget[] {
  const targets: RemovalTarget[] = [];
  for (const command of line.candidates) {
    if (!REMOVERS.has(basename(command.argv[0] ?? ''))) continue;
    const from = command.dir === undefined ? undefined : resolve(cwd, command.dir);
    for (const word of operandsOf(command)) {
      if (/[$`]/.test(word) || (from === undefined && !isAbsolute(word))) {
        targets.push({ word });
        continue;
      }
      const base = from ?? cwd;
      if (/[*?[]/.test(word)) {
        const parts = word.split('/');
        const first = parts.findIndex((part) => /[*?[]/.test(part));
        const dir = parts.slice(0, first).join('/') || (isAbsolute(word) ? '/' : '.');
        const matchesGit = parts
          .slice(first)
          .some((part) => part.startsWith('.') && wildcardRegExp(part).test('.git'));
        targets.push({ word, glob: { base: resolve(base, dir), matchesGit } });
        continue;
      }
      targets.push({ word, path: resolve(base, word) });
    }
  }
  return targets;
}

function operandsOf(command: ShellCommand): string[] {
  const operands: string[] = [];
  let options = true;
  for (const word of command.argv.slice(1)) {
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-') && word !== '-') continue;
    operands.push(word);
  }
  return operands;
}

function wildcardRegExp(part: string): RegExp {
  const source = part
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char === '[' || char === ']' ? char : `\\${char}`
    )
    .join('');
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return /^.*$/;
  }
}

/** Whether `ancestor` is `path` or a directory above it */
function covers(ancestor: string, path: string): boolean {
  if (ancestor === path) return true;
  const prefix = ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`;
  return path.startsWith(prefix);
}

/** Whether removing `path` removes `/`, the home directory, the workspace root, or a `.git` */
function isCriticalPath(path: string, root: string, home: string): boolean {
  const normalized = resolve(path);
  if (normalized === dirname(normalized)) return true;
  if (covers(normalized, root) || covers(normalized, home)) return true;
  return normalized.split(sep).includes('.git');
}

/**
 * The operand of an `rm` or `rmdir` of the line that removes a critical path: `/`, the home
 * directory, the workspace root or a directory above it, a `.git` directory or something in it,
 * an operand the shell expands (`$DIR`), and a wildcard over one of those directories
 * (`rm -rf *` in the root). Undefined when there is none
 */
export function criticalRemoval(
  line: ParsedCommandLine,
  cwd: string,
  root: string,
  home: string = homedir()
): string | undefined {
  for (const target of removalTargets(line, cwd)) {
    if (target.glob) {
      if (target.glob.matchesGit || isCriticalPath(target.glob.base, root, home))
        return target.word;
      continue;
    }
    if (target.path === undefined || isCriticalPath(target.path, root, home)) return target.word;
  }
  return undefined;
}

/**
 * Whether a removal of the line reaches outside the workspace (and its extra directories), or
 * removes what the shell decides (an expansion, a path after a `cd`)
 */
export async function removesOutside(
  line: ParsedCommandLine,
  cwd: string,
  inside: (absolute: string) => Promise<boolean>
): Promise<boolean> {
  for (const target of removalTargets(line, cwd)) {
    const path = target.glob?.base ?? target.path;
    if (path === undefined || !(await inside(path))) return true;
  }
  return false;
}
