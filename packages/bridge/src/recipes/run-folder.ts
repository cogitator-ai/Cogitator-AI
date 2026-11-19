import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CommandMissingError } from '../adapters/exec.js';
import { PLANS_DIR, canonicalPath, isInside } from '../paths.js';
import { GitError, git } from '../worktree.js';

/**
 * The folder a recipe keeps the files of one run in, under the folder the run works in: every
 * session of the run may write there, whatever sandbox its harness puts it in.
 */
export function runFolder(cwd: string, job: number): string {
  return join(canonicalPath(cwd), PLANS_DIR, `job-${job}`);
}

/**
 * Writes a file of a run and resolves with its path. The folder above the runs gets an ignore
 * file the first time, so git sees nothing of what recipes keep. Writing the same text again
 * changes nothing, which is what a step that runs twice does.
 */
export async function keep(folder: string, name: string, text: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const ignore = join(dirname(folder), '.gitignore');
  if (!existsSync(ignore)) await writeFile(ignore, '*\n');
  const path = join(folder, name);
  await writeFile(path, text);
  return path;
}

/** The text of a file, undefined when there is none or it holds nothing but white space. */
export async function kept(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The top of the repository `cwd` is in, undefined when it is in none or there is no git. */
async function topOf(cwd: string): Promise<string | undefined> {
  try {
    return canonicalPath((await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim());
  } catch (error) {
    if (error instanceof GitError || error instanceof CommandMissingError) return undefined;
    throw error;
  }
}

/** The folder a result may be copied into: the repository of `cwd`, `cwd` itself without one. */
export async function outRoot(cwd: string): Promise<string> {
  return (await topOf(cwd)) ?? canonicalPath(cwd);
}

function targetOf(cwd: string, out: string): string {
  return canonicalPath(resolve(canonicalPath(cwd), out));
}

function placeProblem(root: string, target: string, out: string): string | undefined {
  if (!isInside(root, target) || target === root) {
    return `a result is copied inside ${root} only, and ${out} is outside it`;
  }
  if (relative(root, target).split(sep)[0] === '.git') {
    return `${out} is in the .git folder of the repository`;
  }
  return undefined;
}

/**
 * What is wrong with a place to copy a result to, undefined when it can go there: inside the
 * repository of `cwd`, outside its `.git`, and where nothing is yet.
 */
export async function outProblem(cwd: string, out: string): Promise<string | undefined> {
  const target = targetOf(cwd, out);
  const problem = placeProblem(await outRoot(cwd), target, out);
  if (problem) return problem;
  return existsSync(target) ? `${target} is there already: name a path nothing is at` : undefined;
}

/**
 * Copies a file of a run to `out`, a path from `cwd`, and resolves with where it is now. A file
 * that is there already is left alone unless it holds the same text, as it does when the step
 * runs a second time.
 *
 * @throws Error when `out` is no place for it, or something else is there
 */
export async function copyOut(from: string, cwd: string, out: string): Promise<string> {
  const target = targetOf(cwd, out);
  const problem = placeProblem(await outRoot(cwd), target, out);
  if (problem) throw new Error(problem);
  if (existsSync(target)) {
    const same = (await kept(target)) === (await kept(from)) && (await stat(target)).isFile();
    if (same) return target;
    throw new Error(`${target} is there already, with something else in it`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(from, target);
  return target;
}

const MARK = '\t';

/**
 * What git says is changed or new in the repository of `cwd`, a line for each file with its
 * size and the time it was written, so a file that was changed already and is written again
 * shows too. Undefined when `cwd` is in no repository.
 */
export async function treeOf(cwd: string): Promise<string[] | undefined> {
  const top = await topOf(cwd);
  if (top === undefined) return undefined;
  const listed = await git(top, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const parts = listed.stdout.split('\0').filter((part) => part !== '');
  const lines: string[] = [];
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at] ?? '';
    const status = part.slice(0, 2);
    const path = part.slice(3);
    if (/[RC]/.test(status)) at += 1;
    const written = await stat(join(top, path)).then(
      (found) => `${found.size}:${found.mtimeMs}`,
      () => 'gone'
    );
    lines.push(`${status.trim()} ${path}${MARK}${written}`);
  }
  return lines.sort();
}

/**
 * The files of a later look at the tree that an earlier one did not show as they are now,
 * without those at or under `except`, paths from the top of the repository. Each as git
 * names it: `M src/a.ts`, `?? notes.md`.
 */
export function changedSince(
  before: readonly string[],
  after: readonly string[],
  except: readonly string[]
): string[] {
  const seen = new Set(before);
  const pathOf = (shown: string): string => shown.slice(shown.indexOf(' ') + 1);
  return after
    .filter((line) => !seen.has(line))
    .map((line) => line.slice(0, line.indexOf(MARK)))
    .filter((shown) => !except.some((folder) => isInside(folder, pathOf(shown))))
    .sort((one, other) => (pathOf(one) < pathOf(other) ? -1 : 1));
}
