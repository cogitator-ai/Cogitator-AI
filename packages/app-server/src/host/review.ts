import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReviewTarget } from '../protocol/types.js';

/** The most characters of changes a review prompt carries, the rest cut with a note */
export const MAX_REVIEW_CHANGES_CHARS = 200_000;

const MAX_UNTRACKED_FILE_CHARS = 20_000;

/** The instructions of the agent that reviews */
export const REVIEW_INSTRUCTIONS = `You review code changes the way a careful senior engineer does before a merge.

Report only problems the author would want to fix: bugs, broken edge cases, security holes, data loss, races, wrong error handling, missing tests for risky logic, and changes that do not do what they claim. Skip style nits unless they hide a bug.

For each finding give a one-line title, a body that says why it is a problem and how to fix it, a priority (0 must be fixed before merging, 1 should be fixed soon, 2 is worth fixing, 3 is a nit), your confidence from 0 to 1, and the file and lines when it is about specific code.

End with whether the changes are correct overall and a short explanation. With nothing to report, return no findings and say the changes look correct.`;

/** Reads what a review looks at, as text for the review prompt */
export type ReviewContextReader = (target: ReviewTarget) => Promise<string>;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise(stdout);
      }
    );
  });
}

function capped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} more characters left out]`;
}

async function untrackedFiles(cwd: string): Promise<string> {
  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listed.split('\0').filter((path) => path !== '');
  const parts: string[] = [];
  for (const path of paths) {
    const content = await readFile(resolve(cwd, path), 'utf8').catch(() => undefined);
    parts.push(
      content === undefined || content.includes('\0')
        ? `New file ${path} (not shown)`
        : `New file ${path}:\n${capped(content, MAX_UNTRACKED_FILE_CHARS)}`
    );
  }
  return parts.join('\n\n');
}

/**
 * The commit `revision` names in the repository at `cwd`, as its full object id. A revision that
 * starts with `-` is refused before git sees it, so it can never be read as an option, and
 * `--end-of-options` keeps git from reading it as one too
 */
export async function resolveCommit(cwd: string, revision: string): Promise<string> {
  if (revision.trim() === '' || revision.startsWith('-')) {
    throw new Error(`Not a revision: ${JSON.stringify(revision)}`);
  }
  const oid = (
    await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`Not a commit: ${JSON.stringify(revision)}`);
  return oid;
}

/**
 * Reads the changes of a target from the git repository at `cwd`: the working tree against
 * HEAD with the untracked files, the branch since it left `branch`, or one commit. The branch and
 * the commit are resolved to object ids first (see {@link resolveCommit}), so what a client sends
 * never reaches git as an option. A custom target reads nothing
 */
export function gitReviewContext(cwd: string): ReviewContextReader {
  return async (target) => {
    switch (target.type) {
      case 'uncommittedChanges': {
        const diff = await git(cwd, ['diff', 'HEAD', '--no-color']);
        const untracked = await untrackedFiles(cwd);
        return [diff.trim(), untracked].filter((part) => part !== '').join('\n\n');
      }
      case 'baseBranch': {
        const branch = await resolveCommit(cwd, target.branch);
        const base = (await git(cwd, ['merge-base', 'HEAD', branch])).trim();
        return git(cwd, ['diff', '--no-color', base, '--']);
      }
      case 'commit': {
        const oid = await resolveCommit(cwd, target.sha);
        return git(cwd, ['show', '--no-color', '--format=commit %H%n%n%B', oid, '--']);
      }
      case 'custom':
        return '';
    }
  };
}

/** The prompt of a review: what to review and the changes */
export function reviewPrompt(target: ReviewTarget, changes: string): string {
  const what =
    target.type === 'uncommittedChanges'
      ? 'Review the uncommitted changes of the working tree.'
      : target.type === 'baseBranch'
        ? `Review the changes of the current branch against ${target.branch}.`
        : target.type === 'commit'
          ? `Review commit ${target.sha}${target.title ? ` (${target.title})` : ''}.`
          : target.instructions;
  const body = changes.trim();
  if (body === '') {
    return target.type === 'custom' ? what : `${what}\n\nThere are no changes to review.`;
  }
  return `${what}\n\n<changes>\n${capped(body, MAX_REVIEW_CHANGES_CHARS)}\n</changes>`;
}
