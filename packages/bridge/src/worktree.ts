import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { runCommand } from './adapters/exec.js';
import { JOB_WORKTREES_DIR, canonicalPath, isInside } from './paths.js';

export { JOB_WORKTREES_DIR };

/** Where the work of a worktree nobody took or dropped is kept when the worktree goes. */
export const DISCARDED_REFS = 'refs/cogitator/discarded';

const GIT_TIMEOUT_MS = 120_000;

/** The id git reads as "no commit": the old value of a ref that must not exist yet. */
const NO_COMMIT = '0'.repeat(40);

/** Who a snapshot is by when the repository names nobody. */
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'cogitator bridge',
  GIT_AUTHOR_EMAIL: 'bridge@localhost',
  GIT_COMMITTER_NAME: 'cogitator bridge',
  GIT_COMMITTER_EMAIL: 'bridge@localhost',
};

/** A git command that did not do what it was run for. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly said: string
  ) {
    super(`git ${args[0] ?? ''} failed: ${said || `exit code ${code ?? 'none'}`}`);
    this.name = 'GitError';
  }
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  /** Exit codes that are an answer, not a failure. Only 0 by default */
  accept?: readonly number[];
  input?: string;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {}
): Promise<{ code: number; stdout: string }> {
  const result = await runCommand('git', args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    ...(options.input !== undefined && { input: options.input }),
  });
  if (result.code === null || !(options.accept ?? [0]).includes(result.code)) {
    throw new GitError(args, result.code, (result.stderr.trim() || result.stdout.trim()).trim());
  }
  return { code: result.code, stdout: result.stdout };
}

async function gitText(
  cwd: string,
  args: readonly string[],
  options?: GitOptions
): Promise<string> {
  return (await git(cwd, args, options)).stdout.trim();
}

/** The worktree the bridge made for a job. */
export interface JobWorktree {
  /** The top folder of the worktree */
  path: string;
  branch: string;
  /** The commit it was made from: what the job's changes are measured against */
  base: string;
  /** The folder in it that matches the one the job was handed over for */
  cwd: string;
}

export interface AddJobWorktreeOptions {
  /** The main checkout of the project */
  project: string;
  /** The folder the job was handed over for, in the checkout whose commit the worktree starts from */
  from: string;
  number: number;
  title: string;
}

function slug(text: string): string {
  let out = '';
  for (const char of text.toLowerCase()) {
    if (/[a-z0-9]/.test(char)) out += char;
    else if (out !== '' && !out.endsWith('-')) out += '-';
    if (out.length >= 32) break;
  }
  return out.replace(/-+$/, '');
}

/**
 * Makes the git worktree of a job: `.cogitator/worktrees/job-<number>-<title>` under the main
 * checkout of the project, on a branch `cogitator/job-<number>-<title>`, off the commit the
 * checkout of `from` is at. History is shared with the project and only the working files are
 * new, so what that checkout has not committed is not there, and neither is anything git
 * ignores, such as installed dependencies and build output.
 *
 * @throws GitError when `from` is in no git repository, or the repository has no commit yet
 */
export async function addJobWorktree(options: AddJobWorktreeOptions): Promise<JobWorktree> {
  const from = canonicalPath(options.from);
  const top = canonicalPath(await gitText(from, ['rev-parse', '--show-toplevel']));
  const base = await gitText(from, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const dir = join(canonicalPath(options.project), JOB_WORKTREES_DIR);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) await writeFile(ignore, '*\n');

  const named = slug(options.title);
  const folder = `job-${options.number}${named ? `-${named}` : ''}`;
  const path = join(dir, folder);
  const branch = `cogitator/${folder}`;
  await git(options.project, ['worktree', 'add', '-b', branch, path, base]);

  const inside = relative(top, from);
  const cwd =
    inside !== '' && isInside(top, from) && existsSync(join(path, inside))
      ? join(path, inside)
      : path;
  return { path, branch, base, cwd };
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  /** Lines added, undefined for a binary file */
  insertions?: number;
  deletions?: number;
}

/** What a worktree holds that the commit it started from does not. */
export interface WorktreeChanges {
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  /** Commits made in the worktree since its base */
  commits: number;
  /** The commit the worktree is at */
  head: string;
  /** The tree of everything in the worktree: what is committed, what is not, and new files */
  tree: string;
}

const KINDS: Record<string, ChangeKind> = { A: 'added', D: 'deleted' };

/**
 * Reads what a worktree changed since `base`: its commits, what it has not committed and the
 * files it added, without what git ignores. Nothing of the worktree is touched: the files are
 * staged in an index of their own, not the worktree's, so an agent that cannot commit (a Codex
 * thread in its sandbox cannot) and one that did are read the same way.
 */
export async function changesOf(worktree: string, base: string): Promise<WorktreeChanges> {
  const index = join(tmpdir(), `cogitator-bridge-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await gitText(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    await git(worktree, ['read-tree', head], { env });
    await git(worktree, ['add', '-A', '.'], { env });
    const tree = await gitText(worktree, ['write-tree'], { env });
    const [numstat, names, commits] = await Promise.all([
      git(worktree, ['diff', '--numstat', '-z', '--no-renames', base, tree]),
      git(worktree, ['diff', '--name-status', '-z', '--no-renames', base, tree]),
      gitText(worktree, ['rev-list', '--count', `${base}..${head}`]),
    ]);

    const kinds = new Map<string, ChangeKind>();
    const named = names.stdout.split('\0');
    for (let at = 0; at + 1 < named.length; at += 2) {
      kinds.set(named[at + 1], KINDS[named[at][0]] ?? 'modified');
    }
    const files: ChangedFile[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const entry of numstat.stdout.split('\0')) {
      if (entry === '') continue;
      const [added, removed, ...rest] = entry.split('\t');
      const path = rest.join('\t');
      const file: ChangedFile = { path, kind: kinds.get(path) ?? 'modified' };
      if (added !== '-') {
        file.insertions = Number(added);
        file.deletions = Number(removed);
        insertions += file.insertions;
        deletions += file.deletions;
      }
      files.push(file);
    }
    return { files, insertions, deletions, commits: Number(commits), head, tree };
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export interface PatchOptions {
  /** Only these files, paths from the top of the worktree */
  paths?: readonly string[];
  /** The most characters of the patch to return, 200 000 by default */
  maxChars?: number;
}

const DEFAULT_PATCH_CHARS = 200_000;

/** The changes of a worktree as a patch, cut at `maxChars`. */
export async function patchOf(
  worktree: string,
  base: string,
  tree: string,
  options: PatchOptions = {}
): Promise<{ patch: string; truncated: boolean }> {
  const max = options.maxChars ?? DEFAULT_PATCH_CHARS;
  const { stdout } = await git(worktree, [
    'diff',
    '--no-renames',
    '--no-ext-diff',
    base,
    tree,
    '--',
    ...(options.paths ?? []),
  ]);
  return stdout.length > max
    ? { patch: stdout.slice(0, max), truncated: true }
    : { patch: stdout, truncated: false };
}

/**
 * The commit that holds everything a worktree has: its own last commit when nothing is left
 * uncommitted, else a new commit on top of it with `message`. The new commit is on no branch and
 * the worktree is not touched.
 */
export async function snapshotOf(
  worktree: string,
  changes: Pick<WorktreeChanges, 'head' | 'tree'>,
  message: string
): Promise<string> {
  const committed = await gitText(worktree, ['rev-parse', `${changes.head}^{tree}`]);
  if (committed === changes.tree) return changes.head;
  const [name, email] = await Promise.all(
    ['user.name', 'user.email'].map((key) =>
      gitText(worktree, ['config', '--get', key], { accept: [0, 1] })
    )
  );
  return gitText(worktree, ['commit-tree', changes.tree, '-p', changes.head, '-F', '-'], {
    input: message,
    ...((!name || !email) && { env: FALLBACK_IDENTITY }),
  });
}

/**
 * The files a merge of `commit` into what `target` is at would leave in conflict, none when it
 * merges cleanly. Nothing of `target` is touched: git works the merge out without a checkout.
 *
 * @throws GitError on a git older than 2.38, which cannot
 */
export async function conflictsOf(target: string, commit: string): Promise<string[]> {
  const { code, stdout } = await git(
    target,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', commit],
    { accept: [0, 1] }
  );
  if (code === 0) return [];
  return stdout
    .split('\0')
    .slice(1)
    .filter((path) => path !== '');
}

/** What git is in the middle of in a checkout, by the file or folder it keeps for it. */
const IN_PROGRESS: ReadonlyArray<[string, string]> = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
];

/**
 * Why nothing can be brought into the checkout `target` right now, undefined when it can: git
 * is in the middle of something there, or changes are staged. Bringing work in stages it, so
 * what was staged before could not be told from it afterwards, and git would refuse anyway.
 */
export async function busyWith(target: string): Promise<string | undefined> {
  for (const [name, what] of IN_PROGRESS) {
    const path = await gitText(target, ['rev-parse', '--git-path', name]);
    if (existsSync(isAbsolute(path) ? path : join(target, path))) {
      return `${what} is in progress there`;
    }
  }
  const { code } = await git(target, ['diff', '--cached', '--quiet'], { accept: [0, 1] });
  return code === 0 ? undefined : 'changes are staged there';
}

/**
 * Brings the changes of `commit` into the checkout `target` as one change that is staged and not
 * committed (`git merge --squash`): the commit, with its message and the hooks of the project,
 * is for whoever works there. Only for a checkout `busyWith` finds free: nothing is staged
 * there, so when git gives up half way, taking back what the merge staged takes back nothing
 * else, and what is changed there and not staged stays as it is.
 *
 * @throws GitError when the checkout is not free, or git refuses, as it does when files the
 * merge changes have changes of their own in `target`. The checkout is then as it was
 */
export async function squashInto(target: string, commit: string): Promise<void> {
  const busy = await busyWith(target);
  if (busy) throw new GitError(['merge'], null, busy);
  try {
    await git(target, ['merge', '--squash', '--no-commit', commit]);
  } catch (error) {
    await git(target, ['reset', '--merge'], { accept: [0, 1, 128] }).catch(() => undefined);
    throw error;
  }
}

/** Whether `ancestor` is `commit` or one of the commits it grew from. */
export async function isAncestor(
  folder: string,
  ancestor: string,
  commit: string
): Promise<boolean> {
  const { code } = await git(folder, ['merge-base', '--is-ancestor', ancestor, commit], {
    accept: [0, 1],
  });
  return code === 0;
}

/**
 * Points `ref` (a branch as `refs/heads/<name>`, or any other ref) at `commit`. With `fresh` the
 * ref must not be there yet.
 *
 * @throws GitError when a `fresh` ref exists already
 */
export async function pointRef(
  project: string,
  ref: string,
  commit: string,
  options: { fresh?: boolean } = {}
): Promise<void> {
  await git(project, ['update-ref', ref, commit, ...(options.fresh ? [NO_COMMIT] : [])]);
}

/**
 * Removes the worktree of a job with everything in it, and its branch when one is named. When
 * its folder is gone already, as after someone removed it by hand, git is told to forget the
 * worktrees whose folders are missing, which is the only way it has to forget one.
 */
export async function removeJobWorktree(
  project: string,
  path: string,
  branch?: string
): Promise<void> {
  if (existsSync(path)) await git(project, ['worktree', 'remove', '--force', path]);
  else await git(project, ['worktree', 'prune']);
  if (branch) await git(project, ['branch', '-D', branch], { accept: [0, 1] });
}

/** The commit a branch is at, undefined when there is no such branch. */
export async function branchTip(project: string, branch: string): Promise<string | undefined> {
  const { code, stdout } = await git(
    project,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
    { accept: [0, 1] }
  );
  return code === 0 ? stdout.trim() : undefined;
}

/** The top folder of the checkout `folder` is in, undefined when it is in no git repository. */
export async function checkoutOf(folder: string): Promise<string | undefined> {
  try {
    return canonicalPath(await gitText(folder, ['rev-parse', '--show-toplevel']));
  } catch {
    return undefined;
  }
}

/** A path of a changed file as a letter shows it, with `/` whatever the platform. */
export function shownPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
