/**
 * How the permission engine treats commands the workspace runs in its OS sandbox, and the
 * removals that ask in every mode: `rm` and `rmdir` of a critical path, and removals outside the
 * workspace by a command that runs without the sandbox
 */

import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Tool, Workspace, WorkspaceSandbox, WorkspaceSandboxRoute } from '@cogitator-ai/types';
import type { ParsedCommandLine, ShellCommand } from './shell';

/** How a command call runs with respect to the workspace's sandbox */
export interface SandboxedCall {
  sandbox: WorkspaceSandbox;
  route: WorkspaceSandboxRoute;
  /** Whether the call names hosts of its own (`allowedDomains`) */
  domains: boolean;
}

/** The `run_command` tools `workspaceTools()` made, with the workspace each is bound to, if any */
const workspaceCommandTools = new WeakMap<Tool, { workspace?: Workspace }>();

/**
 * Marks `tool` as a command tool that runs its commands through `Workspace.exec` of `workspace`
 * (or of the run's workspace when it is unbound), so that its calls may run in that workspace's
 * OS sandbox. No other command tool (`exec`, an MCP server's shell) is ever auto-allowed
 */
export function markWorkspaceCommandTool(tool: Tool, workspace?: Workspace): void {
  workspaceCommandTools.set(tool, workspace ? { workspace } : {});
}

/**
 * The workspace a call of the command tool `tool` really executes in, when that is a workspace
 * whose sandbox can confine it: the bound workspace of a `run_command` that `workspaceTools()`
 * made (when the call's workspace is that one or there is none), else the call's workspace for
 * an unbound one. Undefined for any other tool, and for a tool bound to a workspace other than
 * the call's
 */
export function commandWorkspace(
  tool: Tool,
  workspace: Workspace | undefined
): Workspace | undefined {
  const binding = workspaceCommandTools.get(tool);
  if (!binding) return undefined;
  if (!binding.workspace) return workspace;
  return workspace === undefined || workspace === binding.workspace ? binding.workspace : undefined;
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'fish', 'csh', 'tcsh']);
/** Builtins that run a file's code in the shell itself, or change what later commands run */
const SHELL_CHANGERS = new Set(['source', '.', 'alias', 'export', 'trap', 'enable']);
const DECLARERS = new Set(['declare', 'typeset', 'local', 'readonly']);

/**
 * Whether the sandbox may allow the command line without asking: nothing that changes which
 * program runs or runs code the line does not show. A variable set in front of a command
 * (`FOO=bar npm test`, `env FOO=bar ...`), `eval`, `make` with a variable (`make CC=clang`),
 * `source` and `.`, `alias`, `export`, `declare -x` and `set -a` (which make later commands see
 * new variables), `trap` and `enable`, `hash -p`, and a shell that reads its code from stdin
 * (`... | sh`, `bash -s`, `sh < script`) all keep the normal permission flow
 */
export function plainForSandbox(line: ParsedCommandLine): boolean {
  return line.candidates.every((command) => {
    const program = basename(command.argv[0] ?? '');
    const args = command.argv.slice(1);
    if (command.assigned.length > 0 || program === 'eval') return false;
    if (SHELL_CHANGERS.has(program)) return false;
    if (MAKES.has(program) && args.some((word) => ASSIGNMENT.test(word))) return false;
    if (DECLARERS.has(program) && args.some((word) => /^[-+][A-Za-z]*x/.test(word))) return false;
    if (program === 'set' && args.some(exportsAll)) return false;
    if (program === 'hash' && args.some((word) => /^-[A-Za-z]*p/.test(word))) return false;
    return !(SHELLS.has(program) && readsStdin(args));
  });
}

/** Whether a `set` argument turns on `allexport` (`-a`, `-ea`, `-o allexport`) */
function exportsAll(word: string, index: number, words: readonly string[]): boolean {
  if (/^-[A-Za-z]*a/.test(word)) return true;
  return word === '-o' && words[index + 1] === 'allexport';
}

/** Whether a shell with these arguments reads its code from stdin: no `-c` and no script file */
function readsStdin(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') return i + 1 >= args.length;
    if (/^-[A-Za-z]+$/.test(word) && word.includes('s')) return true;
    if (/^-[A-Za-z]+$/.test(word) && word.includes('c')) return false;
    if (word === '-o' || word === '+o') {
      i++;
      continue;
    }
    if (!word.startsWith('-') && !word.startsWith('+')) return false;
  }
  return true;
}

const REMOVERS = new Set(['rm', 'rmdir', 'unlink']);
const FIND_EXECUTORS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

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

/**
 * Whether the shell or another program decides what an operand names: an expansion (`$DIR`, a
 * backtick), a brace expansion (`{a,b}`, `{1..3}`), or the `{}` of `find -exec` and `xargs -I`
 */
function decidedAtRunTime(word: string): boolean {
  return (
    /[$`]/.test(word) || word.startsWith('~') || hasBraceExpansion(word) || word.includes('{}')
  );
}

/** Whether `word` holds a `{...}` with a comma or `..` and no brace inside, scanned once */
function hasBraceExpansion(word: string): boolean {
  let open = -1;
  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    if (char === '{') open = i;
    else if (char === '}' && open !== -1) {
      const inner = word.slice(open + 1, i);
      if (inner.includes(',') || inner.includes('..')) return true;
      open = -1;
    }
  }
  return false;
}

/** The operands of the `rm`, `rmdir` and `unlink` commands of a line, resolved from `cwd` */
function removalTargets(
  line: ParsedCommandLine,
  cwd: string,
  ignoreCase: boolean
): RemovalTarget[] {
  const targets: RemovalTarget[] = [];
  for (const command of line.candidates) {
    const generated = generatedRemoval(command);
    if (generated !== undefined) {
      targets.push({ word: generated });
      continue;
    }
    const program = basename(command.argv[0] ?? '');
    const words = REMOVERS.has(program)
      ? operandsOf(command)
      : program === 'mv'
        ? movedOperands(command)
        : program === 'rsync'
          ? rsyncDeletes(command)
          : [];
    if (words.length === 0) continue;
    const from = command.dir === undefined ? undefined : resolve(cwd, command.dir);
    for (const word of words) {
      if (decidedAtRunTime(word) || (from === undefined && !isAbsolute(word))) {
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
          .some((part) => part.startsWith('.') && wildcardRegExp(part, ignoreCase).test('.git'));
        targets.push({ word, glob: { base: resolve(base, dir), matchesGit } });
        continue;
      }
      targets.push({ word, path: resolve(base, word) });
    }
  }
  return targets;
}

/**
 * A removal whose operands another program finds while it runs, as the text to report: `xargs`
 * running a remover, `find` with `-delete` or a remover under `-exec`. Undefined for anything else
 */
function generatedRemoval(command: ShellCommand): string | undefined {
  const program = basename(command.argv[0] ?? '');
  const args = command.argv.slice(1);
  if (program === 'xargs' && args.some((word) => REMOVERS.has(basename(word)))) {
    return command.text;
  }
  if (program !== 'find') return undefined;
  const runsRemover = args.some(
    (word, index) => FIND_EXECUTORS.has(word) && REMOVERS.has(basename(args[index + 1] ?? ''))
  );
  return runsRemover || args.includes('-delete') ? command.text : undefined;
}

/** The sources of an `mv`: every operand but the destination, which `-t` may name instead */
function movedOperands(command: ShellCommand): string[] {
  const args = command.argv.slice(1);
  const target = args.findIndex((word) => word === '-t' || word === '--target-directory');
  const named = target !== -1 || args.some((word) => /^(-t.|--target-directory=)/.test(word));
  const operands = operandsOf({
    ...command,
    argv: [command.argv[0], ...args.filter((_, index) => target === -1 || index !== target + 1)],
  });
  return named ? operands : operands.slice(0, -1);
}

/**
 * What an `rsync` removes: with `--delete` (any form) the destination, whose content it prunes,
 * with `--remove-source-files` the sources too. Nothing without either
 */
function rsyncDeletes(command: ShellCommand): string[] {
  const args = command.argv.slice(1);
  const operands = operandsOf(command);
  const removed: string[] = [];
  if (args.includes('--remove-source-files')) removed.push(...operands.slice(0, -1));
  if (args.some((word) => word.startsWith('--delete')) && operands.length > 1) {
    removed.push(operands[operands.length - 1]);
  }
  return removed;
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

function wildcardRegExp(part: string, ignoreCase: boolean): RegExp {
  const source = part
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char === '[' || char === ']' ? char : `\\${char}`
    )
    .join('');
  try {
    return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
  } catch {
    return /^.*$/;
  }
}

/** Whether `ancestor` is `path` or a directory above it */
function covers(ancestor: string, path: string, ignoreCase: boolean): boolean {
  const [a, p] = ignoreCase ? [ancestor.toLowerCase(), path.toLowerCase()] : [ancestor, path];
  if (a === p) return true;
  const prefix = a.endsWith(sep) ? a : `${a}${sep}`;
  return p.startsWith(prefix);
}

/** Whether removing `path` removes `/`, the home directory, the workspace root, or a `.git` */
function isCriticalPath(path: string, root: string, home: string, ignoreCase: boolean): boolean {
  const normalized = resolve(path);
  if (normalized === dirname(normalized)) return true;
  if (covers(normalized, root, ignoreCase) || covers(normalized, home, ignoreCase)) return true;
  return normalized.split(sep).some((part) => (ignoreCase ? part.toLowerCase() : part) === '.git');
}

/** How {@link criticalRemoval} compares paths */
export interface CriticalRemovalOptions {
  /** The home directory (default: the user's) */
  home?: string;
  /** Whether the filesystem ignores case, so `.GIT` is `.git` (default: false) */
  ignoreCase?: boolean;
}

/**
 * The operand of an `rm` or `rmdir` of the line that removes a critical path: `/`, the home
 * directory, the workspace root or a directory above it, a `.git` directory or something in it,
 * an operand the shell or another program decides (`$DIR`, `{a,b}`, the `{}` of `find -exec`, the
 * input of `xargs rm`, `find -delete`), and a wildcard over one of those directories (`rm -rf *`
 * in the root). Undefined when there is none
 */
export function criticalRemoval(
  line: ParsedCommandLine,
  cwd: string,
  root: string,
  options: CriticalRemovalOptions | string = {}
): string | undefined {
  const { home = homedir(), ignoreCase = false } =
    typeof options === 'string' ? { home: options } : options;
  for (const target of removalTargets(line, cwd, ignoreCase)) {
    if (target.glob) {
      if (target.glob.matchesGit || isCriticalPath(target.glob.base, root, home, ignoreCase))
        return target.word;
      continue;
    }
    if (target.path === undefined || isCriticalPath(target.path, root, home, ignoreCase)) {
      return target.word;
    }
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
  for (const target of removalTargets(line, cwd, false)) {
    const path = target.glob?.base ?? target.path;
    if (path === undefined || !(await inside(path))) return true;
  }
  return false;
}
