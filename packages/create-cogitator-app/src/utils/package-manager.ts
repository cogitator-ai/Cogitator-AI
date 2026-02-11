import { execSync } from 'node:child_process';
import type { PackageManager } from '../types.js';

export function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent;
  if (ua) {
    if (ua.startsWith('pnpm')) return 'pnpm';
    if (ua.startsWith('yarn')) return 'yarn';
    if (ua.startsWith('bun')) return 'bun';
  }
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
