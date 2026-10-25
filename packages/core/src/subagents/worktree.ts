import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Workspace } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';

/** Where the worktrees of isolated subagents go, under the repository's top folder */
export const WORKTREES_DIR = join('.cogitator', 'worktrees');

/** A git worktree a subagent works in, see {@link openWorktree} */
export interface SubagentWorktree {
  /** The worktree's folder */
  path: string;
  /** The branch made for it */
  branch: string;
  /** The workspace over it, at the same place in the repository as the caller's */
  workspace: Workspace;
  /**
   * Disposes the workspace and removes the worktree and its branch when the subagent left no
   * change (nothing uncommitted or ignored, no commit of its own). Returns whether they were kept
   */
  close(): Promise<{ kept: boolean }>;
  /** Disposes the workspace and keeps the worktree, for a delegate that paused and goes on later */
  release(): Promise<void>;
}

function git(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        signal,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`git ${args[0] ?? ''} failed: ${String(stderr || error.message).trim()}`)
          );
          return;
        }
        resolvePromise(String(stdout).trim());
      }
    );
  });
}

/**
 * Whether the worktree at `path` holds anything uncommitted (ignored files included, such as
 * build output) or commits since `base`, true when git cannot tell
 */
async function hasChanges(path: string, base: string): Promise<boolean> {
  try {
    const status = await git(['status', '--porcelain', '--ignored'], path);
    const commits = await git(['rev-list', '--count', `${base}..HEAD`], path);
    return status !== '' || commits !== '0';
  } catch {
    return true;
  }
}

function slug(name: string): string {
  let out = '';
  for (const char of name) {
    const keep = /[A-Za-z0-9._]/.test(char);
    if (keep) out += char;
    else if (out !== '' && !out.endsWith('-')) out += '-';
    if (out.length >= 40) break;
  }
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out || 'agent';
}

/**
 * The git worktree of subagent `name` for the delegation `key` (the run and tool call that
 * delegate), off the current commit of the repository the local `workspace` is in, under
 * `.cogitator/worktrees/` of its top folder (kept out of git status by a `.gitignore` there), on
 * a branch `cogitator/<name>-<hash>`. The same key opens the same worktree again, so a delegate
 * that paused goes on where it left off. The worktree's workspace is at the same place in the
 * repository as `workspace`, with its current directory and all its settings (file limits,
 * command environment, `exec.launch` sandbox). A `problem` instead for a workspace
 * that is not on this machine or not in a git repository
 */
export async function openWorktree(
  workspace: Workspace | undefined,
  name: string,
  key: string,
  signal?: AbortSignal
): Promise<SubagentWorktree | { problem: string }> {
  if (!(workspace instanceof LocalWorkspace)) {
    return { problem: 'isolation: worktree needs a local workspace, the subagent runs without it' };
  }
  let top: string;
  try {
    top = await git(['rev-parse', '--show-toplevel'], workspace.root, signal);
  } catch {
    return {
      problem: `isolation: worktree needs a git repository, ${workspace.root} is not in one, the subagent runs without it`,
    };
  }
  const folder = `${slug(name)}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
  const dir = join(top, WORKTREES_DIR);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  try {
    await access(ignore);
  } catch {
    await writeFile(ignore, '*\n');
  }
  const path = join(dir, folder);
  const branch = `cogitator/${folder}`;
  const baseFile = `${path}.base`;
  let base: string;
  try {
    await access(path);
    base = (await readFile(baseFile, 'utf8')).trim();
  } catch {
    base = await git(['rev-parse', 'HEAD'], top, signal);
    await git(['worktree', 'add', '-b', branch, path, base], top, signal);
    await writeFile(baseFile, `${base}\n`);
  }
  const inside = relative(top, resolve(workspace.root));
  const root = inside === '' || inside.startsWith('..') ? path : join(path, inside);
  const isolated = workspace.withRoot(root);
  await isolated.start();
  return {
    path,
    branch,
    workspace: isolated,
    close: async () => {
      await isolated.dispose();
      if (await hasChanges(path, base)) return { kept: true };
      await git(['worktree', 'remove', '--force', path], top);
      await git(['branch', '-D', branch], top).catch(() => undefined);
      await rm(baseFile, { force: true });
      return { kept: false };
    },
    release: async () => {
      await isolated.dispose();
    },
  };
}
