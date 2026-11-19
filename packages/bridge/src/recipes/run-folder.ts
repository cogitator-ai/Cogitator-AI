import { constants, existsSync } from 'node:fs';
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

async function sameBytes(one: string, other: string): Promise<boolean> {
  try {
    return (await readFile(one)).equals(await readFile(other));
  } catch {
    return false;
  }
}

function isTaken(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return code === 'EEXIST' || code === 'EISDIR';
}

/**
 * Copies a file of a run to `out`, a path from `cwd`, and resolves with where it is now. The
 * copy is made only where nothing is: of two runs that copy to one place at the same moment one
 * is refused, and so is a copy over a file somebody put there meanwhile. A file that holds the
 * same bytes already is left as it is, as when the step runs a second time.
 *
 * @throws Error when `out` is no place for it, or something else is there
 */
export async function copyOut(from: string, cwd: string, out: string): Promise<string> {
  const target = targetOf(cwd, out);
  const problem = placeProblem(await outRoot(cwd), target, out);
  if (problem) throw new Error(problem);
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(from, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isTaken(error)) throw error;
    if (!(await sameBytes(from, target))) {
      throw new Error(`${target} is there already, with something else in it`, {
        cause: error,
      });
    }
  }
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
 * What differs between two looks at the tree, without what is at or under `except`, paths from
 * the top of the repository. A file that is new or changed since the earlier look is named as
 * git names it, `M src/a.ts` or `?? notes.md`. A file the earlier look showed and the later one
 * does not is named with what became of it: `?? notes.md, gone` for a new file that was
 * removed, `M src/a.ts, no longer changed` for a change that was undone.
 */
export function changedSince(
  before: readonly string[],
  after: readonly string[],
  except: readonly string[]
): string[] {
  const shownOf = (line: string): string => line.slice(0, line.indexOf(MARK));
  const pathOf = (shown: string): string => shown.slice(shown.indexOf(' ') + 1);
  const seen = new Set(before);
  const still = new Set(after.map((line) => pathOf(shownOf(line))));
  const differing = [
    ...after.filter((line) => !seen.has(line)).map((line) => ({ shown: shownOf(line), what: '' })),
    ...before
      .map(shownOf)
      .filter((shown) => !still.has(pathOf(shown)))
      .map((shown) => ({
        shown,
        what: shown.startsWith('?? ') ? ', gone' : ', no longer changed',
      })),
  ];
  return differing
    .filter(({ shown }) => !except.some((folder) => isInside(folder, pathOf(shown))))
    .sort((one, other) => (pathOf(one.shown) < pathOf(other.shown) ? -1 : 1))
    .map(({ shown, what }) => `${shown}${what}`);
}
