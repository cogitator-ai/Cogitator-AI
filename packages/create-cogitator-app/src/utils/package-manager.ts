import { execSync } from 'node:child_process';
import type { PackageManager } from '../types.js';

/**
 * The package manager that launched the scaffolder, read from the
 * `npm_config_user_agent` it sets (`npm/10.9.8 node/v22...` under npx), or pnpm
 * when there is none.
 */
export function detectPackageManager(): PackageManager {
  const name = process.env.npm_config_user_agent?.split('/')[0];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  return 'pnpm';
}

export function installDependencies(cwd: string, pm: PackageManager) {
  execSync(`${pm} install`, { cwd, stdio: 'inherit' });
}

export function devCommand(pm: PackageManager): string {
  if (pm === 'npm') return 'npm run dev';
  return `${pm} dev`;
}

export function runCommand(pm: PackageManager): string {
  if (pm === 'npm') return 'npx';
  if (pm === 'pnpm') return 'pnpm dlx';
  if (pm === 'yarn') return 'yarn dlx';
  return 'bunx';
}
