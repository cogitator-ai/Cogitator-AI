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

const SYSTEM_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPROTO',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'ENOENT',
  'EINTEGRITY',
  'ELIFECYCLE',
] as const;

const PNPM_CODES = new Set([
  'NO_MATCHING_VERSION',
  'NO_MATURE_MATCHING_VERSION',
  'NO_VERSIONS',
  'META_FETCH_FAIL',
  'TARBALL_INTEGRITY',
  'BAD_TARBALL_SIZE',
  'PEER_DEP_ISSUES',
  'UNSUPPORTED_ENGINE',
  'UNSUPPORTED_PLATFORM',
  'OUTDATED_LOCKFILE',
  'BROKEN_LOCKFILE',
  'LOCKFILE_BREAKING_CHANGE',
  'LOCKFILE_MISSING_DEPENDENCY',
  'NO_OFFLINE_META',
  'NO_OFFLINE_TARBALL',
  'LINKING_FAILED',
  'UNEXPECTED_STORE',
  'STORE_BREAKING_CHANGE',
  'SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER',
  'IGNORED_BUILDS',
  'INVALID_PACKAGE_NAME',
  'PREPARE_PACKAGE',
  ...SYSTEM_CODES,
]);

const NPM_CODES = new Set<string>([
  'ETARGET',
  'ENOVERSIONS',
  'ERESOLVE',
  'EBADENGINE',
  'EBADPLATFORM',
  'ENOTSUP',
  'EJSONPARSE',
  'EUNSUPPORTEDPROTOCOL',
  ...SYSTEM_CODES,
]);

/** Bun's names for network failures, as the Node codes npm and pnpm report. */
const BUN_ERRORS: Record<string, string> = {
  ConnectionRefused: 'ECONNREFUSED',
  ConnectionResetByPeer: 'ECONNRESET',
  ConnectionClosed: 'ECONNRESET',
  ConnectionTimedOut: 'ETIMEDOUT',
  Timeout: 'ETIMEDOUT',
  NetworkUnreachable: 'ENETUNREACH',
  HostUnreachable: 'EHOSTUNREACH',
};

const HTTP_ERROR = /^[45]\d\d$/;

const READERS: ReadonlyArray<(output: string) => string | undefined> = [
  (output) => {
    const code = /\bERR_PNPM_([A-Z0-9_]+)/.exec(output)?.[1];
    if (code === undefined) return undefined;
    const known = PNPM_CODES.has(code) || /^FETCH_[45]\d\d$/.test(code);
    return known ? `ERR_PNPM_${code}` : 'ERR_PNPM_OTHER';
  },
  (output) => {
    const code = /^npm (?:ERR!|error) code (\S+)/m.exec(output)?.[1];
    if (code === undefined) return undefined;
    if (NPM_CODES.has(code)) return code;
    if (/^E[45]\d\d$/.test(code)) return code;
    return /^npm (?:ERR!|error) command failed/m.test(output) ? 'ELIFECYCLE' : 'NPM_OTHER';
  },
  (output) =>
    [...output.matchAll(/\bYN(\d{4}):/g)]
      .map((match) => Number(match[1]))
      .filter((code) => code > 1 && code < 100)
      .map((code) => `YN${String(code).padStart(4, '0')}`)
      .at(-1),
  (output) =>
    /^error:? (?:No version matching |Couldn't find any versions for )/m.test(output)
      ? 'NO_MATCHING_VERSION'
      : undefined,
  (output) => {
    const status = /^error: GET \S+ - (\d{3})$/m.exec(output)?.[1];
    return status && HTTP_ERROR.test(status) ? `HTTP_${status}` : undefined;
  },
  (output) => (/^error Error: https?:\/\/\S+: Not found/m.test(output) ? 'HTTP_404' : undefined),
  (output) =>
    /^error:? (?:\S+ script from .* exited with|Command failed with exit code) \d+/m.test(output)
      ? 'ELIFECYCLE'
      : undefined,
  (output) => {
    const name = /^error: ([A-Za-z]+) /m.exec(output)?.[1];
    return name !== undefined && Object.hasOwn(BUN_ERRORS, name) ? BUN_ERRORS[name] : undefined;
  },
  (output) => SYSTEM_CODES.find((code) => new RegExp(`\\b${code}\\b`).test(output)),
];

/**
 * The code a failed install names its cause with, read from the package
 * manager's output: pnpm's `ERR_PNPM_*`, npm's `code E*`, Yarn's last `YN*`
 * code other than the informational `YN0000` and the generic `YN0001`, a code
 * for the messages of Bun and Yarn 1, which have none (`NO_MATCHING_VERSION`,
 * `HTTP_404`, `ELIFECYCLE`, Bun's network errors as Node codes), or a Node
 * network or file system code in the output. Else the exit code, as `EXIT_1`.
 *
 * The output is not trusted, since install scripts print into it, so every
 * code comes from a closed set: a pnpm or npm code that is not a known one
 * becomes `ERR_PNPM_OTHER` or `NPM_OTHER`, and nothing else of the output is
 * ever returned.
 */
export function installErrorCode(output: string, exitCode: number): string {
  for (const read of READERS) {
    const code = read(output);
    if (code !== undefined) return code;
  }
  return /\bYN0001:/.test(output) ? 'YN0001' : `EXIT_${exitCode}`;
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
