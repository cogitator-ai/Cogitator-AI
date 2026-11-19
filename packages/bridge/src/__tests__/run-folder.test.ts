import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changedSince,
  copyOut,
  keep,
  kept,
  outProblem,
  outRoot,
  runFolder,
  treeOf,
} from '../recipes/run-folder';

let scratch: string;
let repo: string;
let bare: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-run-folder-')));
  repo = join(scratch, 'demo');
  bare = join(scratch, 'plain');
  mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
  mkdirSync(bare);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), 'demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the folder of a recipe run', () => {
  it('lies under the folder the run works in, and git does not see what is kept there', async () => {
    const folder = runFolder(join(repo, 'packages', 'app'), 7);
    expect(folder).toBe(join(repo, 'packages', 'app', '.cogitator', 'plans', 'job-7'));

    const path = await keep(folder, 'draft-1.md', '# A plan\n');
    expect(path).toBe(join(folder, 'draft-1.md'));
    expect(await keep(folder, 'draft-1.md', '# A plan\n')).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('# A plan\n');
    expect(readFileSync(join(folder, '..', '.gitignore'), 'utf8')).toBe('*\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('leaves an ignore file a person wrote as it is', async () => {
    const folder = runFolder(repo, 1);
    mkdirSync(join(repo, '.cogitator', 'plans'), { recursive: true });
    writeFileSync(join(repo, '.cogitator', 'plans', '.gitignore'), '*\n!keep.md\n');
    await keep(folder, 'plan.md', 'x');
    expect(readFileSync(join(repo, '.cogitator', 'plans', '.gitignore'), 'utf8')).toBe(
      '*\n!keep.md\n'
    );
  });

  it('reads a file back, and takes a missing or blank one for nothing', async () => {
    const folder = runFolder(repo, 1);
    const path = await keep(folder, 'plan.md', '# Plan\n');
    expect(await kept(path)).toBe('# Plan\n');
    expect(await kept(join(folder, 'decisions.md'))).toBeUndefined();
    expect(await kept(await keep(folder, 'blank.md', ' \n\t\n'))).toBeUndefined();
    expect(await kept(folder)).toBeUndefined();
  });
});

describe('where a plan may be copied to', () => {
  it('is the repository of the folder, and the folder itself without one', async () => {
    expect(await outRoot(join(repo, 'packages', 'app'))).toBe(repo);
    expect(await outRoot(bare)).toBe(bare);
  });

  it('takes a path inside, and refuses one outside, in the git folder, or taken already', async () => {
    const cwd = join(repo, 'packages', 'app');
    expect(await outProblem(cwd, 'docs/plan.md')).toBeUndefined();
    expect(await outProblem(cwd, '../../docs/plan.md')).toBeUndefined();
    expect(await outProblem(cwd, join(repo, 'plan.md'))).toBeUndefined();
    expect(await outProblem(cwd, '../../../plan.md')).toContain('outside');
    expect(await outProblem(cwd, join(scratch, 'plan.md'))).toContain('outside');
    expect(await outProblem(cwd, '../../.git/plan.md')).toContain('.git');
    expect(await outProblem(cwd, '../../README.md')).toContain('is there already');
    expect(await outProblem(cwd, '../app')).toContain('is there already');

    expect(await outProblem(bare, 'notes/plan.md')).toBeUndefined();
    expect(await outProblem(bare, '../plan.md')).toContain('outside');
  });

  it('copies a file there, with the folders on the way', async () => {
    const cwd = join(repo, 'packages', 'app');
    const plan = await keep(runFolder(cwd, 3), 'plan.md', '# Plan\n');
    const copied = await copyOut(plan, cwd, '../../docs/plans/limiter.md');
    expect(copied).toBe(join(repo, 'docs', 'plans', 'limiter.md'));
    expect(readFileSync(copied, 'utf8')).toBe('# Plan\n');
    expect(await copyOut(plan, cwd, '../../docs/plans/limiter.md')).toBe(copied);
  });

  it('does not write over a file that holds something else', async () => {
    const plan = await keep(runFolder(repo, 3), 'plan.md', '# Plan\n');
    writeFileSync(join(repo, 'taken.md'), 'mine\n');
    await expect(copyOut(plan, repo, 'taken.md')).rejects.toThrow('is there already');
    expect(readFileSync(join(repo, 'taken.md'), 'utf8')).toBe('mine\n');
    await expect(copyOut(plan, repo, '../plan.md')).rejects.toThrow('outside');
    expect(existsSync(join(scratch, 'plan.md'))).toBe(false);
  });
});

describe('what changed in the working tree', () => {
  it('names what is new since a look before, and not what was there', async () => {
    writeFileSync(join(repo, 'dirty.ts'), 'before\n');
    const before = await treeOf(join(repo, 'packages', 'app'));
    expect(before).toHaveLength(1);

    writeFileSync(join(repo, 'packages', 'app', 'new.ts'), 'x\n');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'plan.md'), '# Plan\n');
    await keep(runFolder(repo, 1), 'plan.md', '# Plan\n');
    const after = await treeOf(repo);

    expect(changedSince(before ?? [], after ?? [], [])).toEqual([
      'M README.md',
      '?? docs/plan.md',
      '?? packages/app/new.ts',
    ]);
    expect(changedSince(before ?? [], after ?? [], ['docs/plan.md', 'packages'])).toEqual([
      'M README.md',
    ]);
  });

  it('sees a file that was changed before and is written again', async () => {
    const file = join(repo, 'dirty.ts');
    writeFileSync(file, 'before\n');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const before = await treeOf(repo);
    writeFileSync(file, 'after, and longer\n');
    const after = await treeOf(repo);
    expect(changedSince(before ?? [], after ?? [], [])).toEqual(['?? dirty.ts']);
    expect(changedSince(before ?? [], before ?? [], [])).toEqual([]);
  });

  it('is unknown outside a repository', async () => {
    expect(await treeOf(bare)).toBeUndefined();
  });
});
