import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCARDED_REFS,
  GitError,
  addJobWorktree,
  changesOf,
  checkoutOf,
  conflictsOf,
  isAncestor,
  patchOf,
  pointRef,
  removeJobWorktree,
  snapshotOf,
  squashInto,
} from '../worktree';

let scratch: string;
let repo: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-worktree-')));
  repo = join(scratch, 'demo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  write(repo, 'README.md', 'demo\n');
  write(repo, 'src/limiter.ts', 'export const limit = 1;\n');
  write(repo, '.gitignore', 'node_modules\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the worktree of a job', () => {
  it('is a checkout of its own under the project, on a branch of its own, off the commit of its caller', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'src/limiter.ts', 'export const limit = 2;\n');

    const made = await addJobWorktree({
      project: repo,
      from: join(repo, 'src'),
      number: 7,
      title: 'Fix the Limiter: off by one!',
    });

    expect(made).toEqual({
      path: join(repo, '.cogitator', 'worktrees', 'job-7-fix-the-limiter-off-by-one'),
      branch: 'cogitator/job-7-fix-the-limiter-off-by-one',
      base,
      cwd: join(repo, '.cogitator', 'worktrees', 'job-7-fix-the-limiter-off-by-one', 'src'),
    });
    expect(read(made.path, 'src/limiter.ts')).toBe('export const limit = 1;\n');
    expect(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(made.branch);
    expect(git(repo, 'status', '--porcelain')).toBe(' M src/limiter.ts');
    expect(await checkoutOf(made.cwd)).toBe(made.path);
  });

  it('starts from the commit of a linked worktree its caller works in, and still lives under the project', async () => {
    const linked = join(scratch, 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    write(linked, 'feature.txt', 'new\n');
    git(linked, 'add', '-A');
    git(linked, 'commit', '-q', '-m', 'feature');

    const made = await addJobWorktree({ project: repo, from: linked, number: 2, title: '...' });

    expect(made.path).toBe(join(repo, '.cogitator', 'worktrees', 'job-2'));
    expect(made.base).toBe(git(linked, 'rev-parse', 'HEAD'));
    expect(existsSync(join(made.path, 'feature.txt'))).toBe(true);
    expect(made.cwd).toBe(made.path);
  });

  it('refuses a folder that is in no repository, and a repository with no commit', async () => {
    const plain = join(scratch, 'plain');
    mkdirSync(plain);
    await expect(
      addJobWorktree({ project: plain, from: plain, number: 1, title: 'x' })
    ).rejects.toBeInstanceOf(GitError);

    const empty = join(scratch, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    await expect(
      addJobWorktree({ project: empty, from: empty, number: 1, title: 'x' })
    ).rejects.toBeInstanceOf(GitError);
    expect(await checkoutOf(plain)).toBeUndefined();
  });

  it('is removed with its branch, also when its folder is gone already', async () => {
    const first = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'one' });
    const second = await addJobWorktree({ project: repo, from: repo, number: 2, title: 'two' });
    write(first.path, 'left.txt', 'uncommitted\n');
    rmSync(second.path, { recursive: true, force: true });

    await removeJobWorktree(repo, first.path, first.branch);
    await removeJobWorktree(repo, second.path, second.branch);

    expect(existsSync(first.path)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, 'branch', '--list', 'cogitator/*')).toBe('');
  });
});

describe('what a worktree changed', () => {
  it('counts its commits, what it left uncommitted and its new files, and nothing git ignores', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'src/limiter.ts', 'export const limit = 1;\nexport const burst = 3;\n');
    git(made.path, 'commit', '-q', '-am', 'burst');
    write(made.path, 'README.md', 'demo, with a burst\n');
    write(made.path, 'src/new file.ts', 'export {};\n');
    write(made.path, 'node_modules/dep/index.js', 'ignored\n');
    writeFileSync(join(made.path, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const indexBefore = git(made.path, 'status', '--porcelain');

    const changes = await changesOf(made.path, made.base);

    expect(changes.files).toEqual([
      { path: 'README.md', kind: 'modified', insertions: 1, deletions: 1 },
      { path: 'logo.bin', kind: 'added' },
      { path: 'src/limiter.ts', kind: 'modified', insertions: 1, deletions: 0 },
      { path: 'src/new file.ts', kind: 'added', insertions: 1, deletions: 0 },
    ]);
    expect(changes).toMatchObject({ insertions: 3, deletions: 1, commits: 1 });
    expect(changes.head).toBe(git(made.path, 'rev-parse', 'HEAD'));
    expect(git(made.path, 'status', '--porcelain')).toBe(indexBefore);
  });

  it('is nothing for a worktree nobody touched, and names a file that was deleted', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    expect(await changesOf(made.path, made.base)).toMatchObject({
      files: [],
      insertions: 0,
      deletions: 0,
      commits: 0,
    });

    rmSync(join(made.path, 'README.md'));
    expect((await changesOf(made.path, made.base)).files).toEqual([
      { path: 'README.md', kind: 'deleted', insertions: 0, deletions: 1 },
    ]);
  });

  it('comes as a patch, whole or of some files, cut where asked', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'README.md', 'changed\n');
    write(made.path, 'notes.txt', 'new\n');
    const changes = await changesOf(made.path, made.base);

    const whole = await patchOf(made.path, made.base, changes.tree);
    const one = await patchOf(made.path, made.base, changes.tree, { paths: ['notes.txt'] });
    const cut = await patchOf(made.path, made.base, changes.tree, { maxChars: 20 });

    expect(whole.truncated).toBe(false);
    expect(whole.patch).toContain('+changed');
    expect(whole.patch).toContain('+new');
    expect(one.patch).toContain('+new');
    expect(one.patch).not.toContain('+changed');
    expect(cut).toEqual({ patch: whole.patch.slice(0, 20), truncated: true });
  });
});

describe('taking the work of a worktree', () => {
  it('snapshots what is uncommitted on top of the commits, on no branch and without touching the worktree', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'a.txt', 'committed\n');
    git(made.path, 'add', '-A');
    git(made.path, 'commit', '-q', '-m', 'a');
    const committed = git(made.path, 'rev-parse', 'HEAD');
    const clean = await changesOf(made.path, made.base);
    expect(await snapshotOf(made.path, clean, 'job #1')).toBe(committed);

    write(made.path, 'b.txt', 'not committed\n');
    const changes = await changesOf(made.path, made.base);
    const snapshot = await snapshotOf(made.path, changes, 'job #1: work\n\nSecond line');

    expect(snapshot).not.toBe(committed);
    expect(git(repo, 'rev-parse', `${snapshot}^`)).toBe(committed);
    expect(git(repo, 'show', '-s', '--format=%B', snapshot)).toBe('job #1: work\n\nSecond line');
    expect(git(repo, 'ls-tree', '-r', '--name-only', snapshot).split('\n')).toContain('b.txt');
    expect(git(made.path, 'rev-parse', 'HEAD')).toBe(committed);
    expect(git(made.path, 'status', '--porcelain')).toBe('?? b.txt');
    expect(await isAncestor(repo, made.base, snapshot)).toBe(true);
    expect(await isAncestor(repo, snapshot, made.base)).toBe(false);
  });

  it('snapshots in a repository that names no author', async () => {
    git(repo, 'config', '--unset', 'user.name');
    git(repo, 'config', '--unset', 'user.email');
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'b.txt', 'x\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const before = { ...process.env };
    Object.assign(process.env, env);
    try {
      const changes = await changesOf(made.path, made.base);
      const snapshot = await snapshotOf(made.path, changes, 'job #1');
      expect(git(repo, 'show', '-s', '--format=%an', snapshot)).toBe('cogitator bridge');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = before.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_SYSTEM = before.GIT_CONFIG_SYSTEM;
      if (before.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      if (before.GIT_CONFIG_SYSTEM === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    }
  });

  it('lands in a checkout staged and not committed, next to what is being worked on there', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'src/limiter.ts', 'export const limit = 5;\n');
    write(made.path, 'added.txt', 'new\n');
    const changes = await changesOf(made.path, made.base);
    const snapshot = await snapshotOf(made.path, changes, 'job #1');
    write(repo, 'README.md', 'my own edit\n');
    const head = git(repo, 'rev-parse', 'HEAD');

    expect(await conflictsOf(repo, snapshot)).toEqual([]);
    await squashInto(repo, snapshot);

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain').split('\n')).toEqual([
      ' M README.md',
      'A  added.txt',
      'M  src/limiter.ts',
    ]);
    expect(read(repo, 'src/limiter.ts')).toBe('export const limit = 5;\n');
    expect(read(repo, 'README.md')).toBe('my own edit\n');
  });

  it('names the files that would conflict, and leaves the checkout alone', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'src/limiter.ts', 'export const limit = 5;\n');
    write(made.path, 'added.txt', 'new\n');
    const snapshot = await snapshotOf(made.path, await changesOf(made.path, made.base), 'job #1');
    write(repo, 'src/limiter.ts', 'export const limit = 9;\n');
    git(repo, 'commit', '-q', '-am', 'mine');

    expect(await conflictsOf(repo, snapshot)).toEqual(['src/limiter.ts']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is refused by git when a file it changes has changes of its own there, and nothing is left half done', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 1, title: 'work' });
    write(made.path, 'src/limiter.ts', 'export const limit = 5;\n');
    const snapshot = await snapshotOf(made.path, await changesOf(made.path, made.base), 'job #1');
    write(repo, 'src/limiter.ts', 'export const limit = 1; // mine\n');

    await expect(squashInto(repo, snapshot)).rejects.toThrow(/would be overwritten/);

    expect(git(repo, 'status', '--porcelain')).toBe(' M src/limiter.ts');
    expect(read(repo, 'src/limiter.ts')).toBe('export const limit = 1; // mine\n');
  });

  it('is kept under a ref of its own when its worktree goes', async () => {
    const made = await addJobWorktree({ project: repo, from: repo, number: 4, title: 'work' });
    write(made.path, 'kept.txt', 'do not lose me\n');
    const snapshot = await snapshotOf(made.path, await changesOf(made.path, made.base), 'job #4');

    await pointRef(repo, `${DISCARDED_REFS}/job-4`, snapshot);
    await removeJobWorktree(repo, made.path, made.branch);
    git(repo, 'gc', '--prune=now', '-q');

    expect(git(repo, 'show', `${DISCARDED_REFS}/job-4:kept.txt`)).toBe('do not lose me');
  });
});
