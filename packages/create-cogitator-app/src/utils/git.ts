import { execSync } from 'node:child_process';

export function isGitInstalled(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function initGitRepo(cwd: string) {
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git add -A', { cwd, stdio: 'ignore' });
  execSync(
    'git -c user.name="Cogitator" -c user.email="init@cogitator.dev" commit -m "feat: initial project scaffold"',
    { cwd, stdio: 'ignore' }
  );
}
