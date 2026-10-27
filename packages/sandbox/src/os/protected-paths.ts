import { lstat, readFile } from 'node:fs/promises';
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
}

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
 * hooks and config of the repository (of the main repository too for a linked worktree, and
 * where they would go when the root is no repository yet, so none is made with hooks),
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
  const candidates: Array<{ path: string; directory: boolean }> = [];
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
  for (const dir of gitDirs) {
    candidates.push({ path: join(dir, 'hooks'), directory: true });
    candidates.push({ path: join(dir, 'config'), directory: false });
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
      });
    }
  }
  return result;
}
