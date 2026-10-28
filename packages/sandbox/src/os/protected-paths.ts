import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isWithin, namesOf } from './paths';

/** The settings, hooks and code of Claude Code a command could grant itself more with */
const CLAUDE_PROTECTED = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.claude/hooks',
  '.claude/workflows',
  '.claude/plugins',
  '.claude/scheduled_tasks.json',
  '.mcp.json',
];

/** Cogitator's own files in a directory above the workspace: settings, hooks, plugins, skills */
const COGITATOR_PROTECTED = [
  '.cogitator/settings.json',
  '.cogitator/settings.local.json',
  '.cogitator/skills',
  '.cogitator/agents',
  '.cogitator/commands',
  '.cogitator/hooks',
  '.cogitator/plugins',
  '.cogitator/plugins.lock',
];

/** Files a shell, git or an editor runs or reads its configuration from, in the working directory */
const ROOT_PROTECTED = [
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.vscode',
  '.idea',
];

/** Why a path is protected, for the deny list a profile carries */
export interface ProtectedPath {
  /** Absolute, a directory covering what it holds */
  path: string;
  /** Whether it exists now (bubblewrap can only mount over an existing path) */
  exists: boolean;
  /** Whether it is a directory when it exists, else what it would be once made */
  directory: boolean;
  /**
   * Only the entry itself is protected: it may not be made, removed, renamed or replaced, while
   * what a directory holds stays writable (the root's `.git` directory, whose index and objects
   * git writes, but which no command may swap for a `gitdir:` file of its own)
   */
  entryOnly?: boolean;
  /**
   * A file git changes course on by its mere presence (`commondir`): bubblewrap puts no mount
   * point where it is missing, and removes one a command made once the command is over
   */
  watched?: boolean;
}

/**
 * Files of a git directory that make git, run outside the sandbox later, read configuration or
 * hooks from elsewhere: `config`, `hooks`, `commondir` (where the shared config and hooks live)
 * and `config.worktree`
 */
const GIT_DIR_PROTECTED: ReadonlyArray<{ name: string; directory: boolean; watched?: true }> = [
  { name: 'hooks', directory: true },
  { name: 'config', directory: false },
  { name: 'commondir', directory: false, watched: true },
  { name: 'config.worktree', directory: false, watched: true },
];

/** The most nested submodule git directories looked at under `.git/modules` */
const MAX_MODULE_DIRS = 200;

/** Names of protected entries that are directories when they do not exist yet */
const DIRECTORY_NAMES = new Set([
  'skills',
  'agents',
  'commands',
  'hooks',
  'workflows',
  'plugins',
  '.vscode',
  '.idea',
]);

/** The git directory of a worktree or a submodule whose `.git` is a file (`gitdir: ...`) */
async function linkedGitDir(dotGit: string): Promise<string | undefined> {
  const text = await readFile(dotGit, 'utf8').catch(() => undefined);
  const match = text?.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) return undefined;
  const target = match[1].trim();
  return target.startsWith('/') ? target : join(dirname(dotGit), target);
}

/**
 * The paths sandboxed commands may not write even inside a writable directory, for a workspace
 * at `root`: Claude Code's and Cogitator's settings, hooks, skills, agents, commands and plugins
 * in the root and every directory above it, the whole `.cogitator` directory of the root (the
 * workspace's trash and snapshots), shell startup files, `.gitconfig`, editor folders, the
 * hooks, config, `commondir` and `config.worktree` of the repository (of the main repository too
 * for a linked worktree, of its linked worktrees and submodules, and where they would go when the
 * root is no repository yet, so none is made with hooks), the root's `.git` entry itself (so no
 * command replaces it with a `gitdir:` file pointing at a git directory of its own),
 * `~/.claude`, `~/.cogitator` and `~/.claude.json` (unless the root lies inside one), and
 * `HEAD` at the root, without which no command can turn the root into a bare repository that
 * git, run outside the sandbox later, would read config and hooks from (with `objects`, `refs`,
 * `config` and `hooks` there too once a `HEAD` exists). A symlink at a protected path protects
 * what it points to as well
 */
export async function protectedPaths(
  root: string,
  home: string = homedir()
): Promise<ProtectedPath[]> {
  const candidates: Array<{
    path: string;
    directory: boolean;
    entryOnly?: boolean;
    watched?: boolean;
  }> = [];
  const add = (path: string) =>
    candidates.push({ path, directory: DIRECTORY_NAMES.has(basename(path)) });
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of [...CLAUDE_PROTECTED, ...COGITATOR_PROTECTED]) add(join(dir, name));
    if (dirname(dir) === dir) break;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  for (const dir of [
    join(home, '.claude'),
    join(home, '.cogitator'),
    ...(configDir ? [configDir] : []),
  ]) {
    if (!isWithin(dir, root)) candidates.push({ path: dir, directory: true });
  }
  candidates.push({ path: join(home, '.claude.json'), directory: false });
  candidates.push({ path: join(root, '.cogitator'), directory: true });
  for (const name of ROOT_PROTECTED) add(join(root, name));
  const dotGit = join(root, '.git');
  const gitInfo = await lstat(dotGit).catch(() => undefined);
  const gitDirs: string[] = [];
  if (!gitInfo?.isFile()) {
    candidates.push({ path: dotGit, directory: true, entryOnly: true });
    gitDirs.push(dotGit);
  } else {
    candidates.push({ path: dotGit, directory: false });
    const gitDir = await linkedGitDir(dotGit);
    if (gitDir) {
      gitDirs.push(gitDir);
      const common = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => ''))?.trim();
      if (common) gitDirs.push(common.startsWith('/') ? common : join(gitDir, common));
    }
  }
  for (const dir of [...gitDirs]) gitDirs.push(...(await nestedGitDirs(dir)));
  for (const dir of gitDirs) {
    for (const file of GIT_DIR_PROTECTED) {
      candidates.push({
        path: join(dir, file.name),
        directory: file.directory,
        ...(file.watched && { watched: true }),
      });
    }
  }
  candidates.push({ path: join(root, 'HEAD'), directory: false });
  if (await lstat(join(root, 'HEAD')).catch(() => undefined)) {
    for (const name of ['objects', 'refs', 'hooks'])
      candidates.push({ path: join(root, name), directory: true });
    candidates.push({ path: join(root, 'config'), directory: false });
  }

  const seen = new Set<string>();
  const result: ProtectedPath[] = [];
  for (const candidate of candidates) {
    for (const name of await namesOf(candidate.path)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const info = await lstat(name).catch(() => undefined);
      result.push({
        path: name,
        exists: info !== undefined,
        directory: info ? info.isDirectory() : candidate.directory,
        ...(candidate.entryOnly && { entryOnly: true }),
        ...(candidate.watched && { watched: true }),
      });
    }
  }
  return result;
}

/**
 * The git directories git keeps inside `gitDir` and reads its own config and hooks from: those of
 * linked worktrees (`worktrees/<name>`, read by git run in that worktree) and of submodules
 * (`modules/<name>`, nested ones too, read by a `git status` that looks into them). Only those
 * that exist now: a submodule a command adds needs `.gitmodules`, which is protected
 */
async function nestedGitDirs(gitDir: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [join(gitDir, 'modules')];
  const children = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  found.push(...(await children(join(gitDir, 'worktrees'))));
  while (queue.length > 0 && found.length < MAX_MODULE_DIRS) {
    for (const dir of await children(queue.shift()!)) {
      if ((await lstat(join(dir, 'HEAD')).catch(() => undefined))?.isFile()) found.push(dir);
      else queue.push(dir);
      queue.push(join(dir, 'modules'));
    }
  }
  return found.slice(0, MAX_MODULE_DIRS);
}
