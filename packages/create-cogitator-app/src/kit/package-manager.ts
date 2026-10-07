import { PACKAGE_MANAGERS, type PackageManager } from './spec.js';

/**
 * The package manager that launched the scaffolder, read from the
 * `npm_config_user_agent` it sets (`npm/10.9.8 node/v22...` under npx), or pnpm
 * when there is none.
 */
export function detectPackageManager(
  userAgent: string | undefined = process.env.npm_config_user_agent
): PackageManager {
  const name = userAgent?.split('/')[0];
  return PACKAGE_MANAGERS.find((pm) => pm === name) ?? 'pnpm';
}

/**
 * The `packageManager` field for the pnpm, Yarn or Bun that runs the scaffolder,
 * e.g. `pnpm@10.26.0`, so corepack and the deploy image install with the same
 * version. Undefined for npm, which corepack leaves alone, and when the version
 * is unknown.
 */
export function detectPackageManagerSpec(
  pm: PackageManager,
  userAgent: string | undefined = process.env.npm_config_user_agent
): string | undefined {
  if (pm === 'npm') return undefined;
  const match = /^(pnpm|yarn|bun)\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent?.trim() ?? '');
  return match?.[1] === pm ? `${match[1]}@${match[2]}` : undefined;
}

/** The command that runs the package.json script `script`. */
export function runScript(pm: PackageManager, script: string, args = ''): string {
  const base = pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
  if (!args) return base;
  return pm === 'npm' ? `${base} -- ${args}` : `${base} ${args}`;
}

/** The command that runs a binary of an installed package. */
export function execCommand(pm: PackageManager, bin: string): string {
  if (pm === 'npm') return `npx ${bin}`;
  if (pm === 'bun') return `bunx ${bin}`;
  return `${pm} exec ${bin}`;
}

export function installCommand(pm: PackageManager): string {
  return `${pm} install`;
}

/** The install command CI runs: reproducible from the lockfile. */
export function ciInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'npm':
      return 'npm ci';
    case 'yarn':
      return 'yarn install --immutable';
    case 'bun':
      return 'bun install --frozen-lockfile';
  }
}

export const LOCKFILES: Record<PackageManager, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};
