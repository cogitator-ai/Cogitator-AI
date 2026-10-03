import { execFileSync } from 'node:child_process';

/** Used only when the user has no git identity, so the first commit can still be made. */
const FALLBACK_IDENTITY = [
  '-c',
  'user.name=create-cogitator-app',
  '-c',
  'user.email=create-cogitator-app@localhost',
];

export function isGitInstalled(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasIdentity(cwd: string): boolean {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim();
    const email = execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8' }).trim();
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

/**
 * Initialises a repository and commits the scaffold, authored by the user's own git identity;
 * a neutral local identity is used only when none is configured.
 */
export function initGitRepo(cwd: string) {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  const identity = hasIdentity(cwd) ? [] : FALLBACK_IDENTITY;
  execFileSync('git', [...identity, 'commit', '-m', 'feat: initial project scaffold'], {
    cwd,
    stdio: 'ignore',
  });
}
