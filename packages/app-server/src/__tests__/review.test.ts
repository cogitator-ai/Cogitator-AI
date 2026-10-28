import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStartParamsSchema } from '../protocol/turn';
import { gitReviewContext, resolveCommit } from '../host/review';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('gitReviewContext', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'app-server-review-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'review@example.com');
    git(repo, 'config', 'user.name', 'Review');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'commit', '-q', '-am', 'second');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reads a commit and a branch through resolved object ids', async () => {
    const read = gitReviewContext(repo);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    expect(await resolveCommit(repo, 'HEAD')).toBe(head);
    expect(await read({ type: 'commit', sha: 'HEAD' })).toContain('+two');
    expect(await read({ type: 'baseBranch', branch: 'main' })).toContain('+two');
  });

  it('shows an untracked symlink as a link, never what it points to', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'app-server-review-outside-'));
    try {
      writeFileSync(join(outside, 'private.txt'), 'top secret');
      symlinkSync(join(outside, 'private.txt'), join(repo, 'link.txt'));
      writeFileSync(join(repo, 'plain.txt'), 'visible');
      const context = await gitReviewContext(repo)({ type: 'uncommittedChanges' });
      expect(context).toContain(`New symlink link.txt -> ${join(outside, 'private.txt')}`);
      expect(context).toContain('visible');
      expect(context).not.toContain('top secret');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never lets a revision reach git as an option', async () => {
    const target = join(repo, 'written-by-git');
    const read = gitReviewContext(repo);
    await expect(read({ type: 'commit', sha: `--output=${target}` })).rejects.toThrow(
      /Not a revision/
    );
    await expect(read({ type: 'baseBranch', branch: `--output=${target}` })).rejects.toThrow(
      /Not a revision/
    );
    await expect(resolveCommit(repo, 'no-such-branch')).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('refuses revisions that start with a dash at the protocol', () => {
    for (const target of [
      { type: 'commit', sha: '--output=x' },
      { type: 'baseBranch', branch: '-b' },
    ]) {
      expect(ReviewStartParamsSchema.safeParse({ threadId: 't', target }).success).toBe(false);
    }
  });
});
