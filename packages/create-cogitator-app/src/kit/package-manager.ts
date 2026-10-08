import { constantCase } from './errors.js';
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

const OUTPUT_CODES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/\b(ERR_PNPM_[A-Z0-9_]+)/, (match) => match[1]],
  [/^npm (?:ERR!|error) code (E[A-Z0-9]+)\b/m, (match) => match[1]],
  [/^npm (?:ERR!|error) command failed/m, () => 'ELIFECYCLE'],
];

const MESSAGE_CODES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^error:? (?:No version matching |Couldn't find any versions for )/m,
    () => 'NO_MATCHING_VERSION',
  ],
  [/^error: GET \S+ - (\d{3})$/m, (match) => `HTTP_${match[1]}`],
  [/^error Error: https?:\/\/\S+: Not found/m, () => 'HTTP_404'],
  [
    /^error:? (?:\S+ script from .* exited with|Command failed with exit code) \d+/m,
    () => 'ELIFECYCLE',
  ],
  [/^error: ([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/m, (match) => constantCase(match[1])],
];

const SYSTEM_CODE =
  /\b(E(?:LIFECYCLE|CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|TIMEDOUT|NETUNREACH|HOSTUNREACH|ACCES|PERM|NOSPC|INTEGRITY|PROTO))\b/;

/**
 * The code a failed install names its cause with, read from the package
 * manager's output: pnpm's `ERR_PNPM_*`, npm's `code E*`, Yarn's last `YN*`
 * code that is not the informational `YN0000`, a code for the messages of Bun
 * and Yarn 1, which have none (`NO_MATCHING_VERSION`, `HTTP_404`,
 * `ELIFECYCLE`, `CONNECTION_REFUSED`), or a Node network or file system code
 * in the output. Else the exit code, as `EXIT_1`. Only these codes are ever
 * taken from the output, never a path or a package name.
 */
export function installErrorCode(output: string, exitCode: number): string {
  for (const [pattern, code] of OUTPUT_CODES) {
    const match = pattern.exec(output);
    if (match) return code(match);
  }
  const yarn = [...output.matchAll(/\b(YN\d{4}):/g)]
    .map((match) => match[1])
    .filter((code) => code !== 'YN0000')
    .at(-1);
  if (yarn && yarn !== 'YN0001') return yarn;
  for (const [pattern, code] of MESSAGE_CODES) {
    const match = pattern.exec(output);
    if (match) return code(match);
  }
  return SYSTEM_CODE.exec(output)?.[1] ?? yarn ?? `EXIT_${exitCode}`;
}

/**
 * The install command CI runs: reproducible from the lockfile. Yarn 2 and
 * later spell it `--immutable`, Yarn 1 `--frozen-lockfile`, which is also what
 * corepack runs when package.json names no Yarn version.
 */
export function ciInstallCommand(pm: PackageManager, packageManagerSpec?: string): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'npm':
      return 'npm ci';
    case 'yarn': {
      const major = Number.parseInt(/^yarn@(\d+)/.exec(packageManagerSpec ?? '')?.[1] ?? '1', 10);
      return major >= 2 ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    }
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
