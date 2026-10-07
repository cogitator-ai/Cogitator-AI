import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { installCommand } from './package-manager.js';
import { planProject, type PlanOptions, type ProjectPlan } from './plan.js';
import { hasCommand, runCommand, tail } from './process.js';
import type { GeneratedFile } from './project.js';
import type { PackageManager } from './spec.js';
import { scaffolderVersion } from './versions.js';

/**
 * Where the scaffolder reports progress. The CLI shows it with spinners, the
 * programmatic API stays silent unless a logger is passed.
 */
export interface ScaffoldLogger {
  start(message: string): void;
  done(message: string): void;
  fail(message: string): void;
  warn(message: string): void;
}

export const silentLogger: ScaffoldLogger = {
  start: () => undefined,
  done: () => undefined,
  fail: () => undefined,
  warn: () => undefined,
};

/** How an optional step went. */
export type StepResult =
  { status: 'done' } | { status: 'skipped'; reason: string } | { status: 'failed'; error: Error };

export interface ScaffoldOptions extends PlanOptions {
  /** The directory to create the project in. It must not exist or be empty. */
  directory: string;
  /** Run the package manager's install (default `true`). */
  install?: boolean;
  /** Initialize a git repository and commit the project (default `true`). */
  git?: boolean;
  log?: ScaffoldLogger;
  /** Show the install's output live instead of capturing it. */
  inheritOutput?: boolean;
}

export interface ScaffoldResult {
  plan: ProjectPlan;
  directory: string;
  /** The generated files, relative to `directory`. */
  files: string[];
  install: StepResult;
  format: StepResult;
  git: StepResult;
  /** The workspace root above the project, when it was created inside one. */
  parentWorkspace?: string;
}

/** Hashes of the files the scaffolder wrote, so `cogitator add` can tell them from files the user edited. */
export interface ScaffoldLock {
  version: 1;
  generator: string;
  files: Record<string, string>;
}

export const LOCK_PATH = '.cogitator/scaffold.json';

/** Files the lock never tracks: they belong to the user from the first moment. */
const UNTRACKED = new Set(['.env']);

export function hashContent(content: string): string {
  return `sha256-${createHash('sha256').update(content).digest('hex')}`;
}

function failure(error: unknown): StepResult {
  return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
}

export async function writeFiles(
  directory: string,
  files: readonly GeneratedFile[]
): Promise<void> {
  for (const file of files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.content,
      file.mode !== undefined ? { mode: file.mode } : undefined
    );
    if (file.mode !== undefined) await chmod(target, file.mode);
  }
}

async function saveLock(directory: string, files: Record<string, string>): Promise<void> {
  const lock: ScaffoldLock = {
    version: 1,
    generator: `create-cogitator-app@${scaffolderVersion()}`,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  await mkdir(join(directory, dirname(LOCK_PATH)), { recursive: true });
  await writeFile(join(directory, LOCK_PATH), JSON.stringify(lock, null, 2) + '\n');
}

/** Hashes `paths` as they are on disk now, `undefined` for a path that does not exist. */
async function hashFiles(
  directory: string,
  paths: readonly string[]
): Promise<Map<string, string | undefined>> {
  const hashes = new Map<string, string | undefined>();
  for (const path of paths) {
    if (UNTRACKED.has(path) || path === LOCK_PATH) continue;
    const full = join(directory, path);
    hashes.set(path, existsSync(full) ? hashContent(await readFile(full, 'utf-8')) : undefined);
  }
  return hashes;
}

export async function writeLock(directory: string, paths: readonly string[]): Promise<void> {
  const files: Record<string, string> = {};
  for (const [path, hash] of await hashFiles(directory, paths)) if (hash) files[path] = hash;
  await saveLock(directory, files);
}

/**
 * Re-hashes `paths` in the lock after `cogitator add` wrote or deleted them,
 * keeping the hashes of every other file.
 */
export async function updateLock(directory: string, paths: readonly string[]): Promise<void> {
  const files = { ...readLock(directory)?.files };
  for (const [path, hash] of await hashFiles(directory, paths)) {
    if (hash) files[path] = hash;
    else delete files[path];
  }
  await saveLock(directory, files);
}

export function readLock(directory: string): ScaffoldLock | undefined {
  const path = join(directory, LOCK_PATH);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('files' in parsed) ||
    typeof parsed.files !== 'object' ||
    parsed.files === null
  ) {
    throw new Error(`${LOCK_PATH} is not a scaffold lock`);
  }
  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(parsed.files)) {
    if (typeof hash === 'string') files[file] = hash;
  }
  const generator =
    'generator' in parsed && typeof parsed.generator === 'string' ? parsed.generator : 'unknown';
  return { version: 1, generator, files };
}

/** The local Biome binary of a project, absent before its dependencies are installed. */
function biomeBinary(directory: string): string | undefined {
  const name = process.platform === 'win32' ? 'biome.cmd' : 'biome';
  const path = join(directory, 'node_modules', '.bin', name);
  return existsSync(path) ? path : undefined;
}

/**
 * Formats the generated code with the project's own Biome, so it starts clean
 * under `lint`: the whole project, or only `paths` when they are given.
 */
export async function formatProject(
  directory: string,
  paths: readonly string[] = ['.']
): Promise<StepResult> {
  const biome = biomeBinary(directory);
  if (!biome) return { status: 'skipped', reason: 'Biome is not installed' };
  if (paths.length === 0) return { status: 'skipped', reason: 'nothing to format' };
  const result = await runCommand(
    biome,
    ['check', '--write', '--no-errors-on-unmatched', ...paths],
    { cwd: directory }
  );
  if (result.code !== 0)
    return failure(new Error(`biome check --write failed:\n${tail(result.output)}`));
  return { status: 'done' };
}

/** The git work tree `directory` is inside of, if any. */
export async function enclosingGitRepo(directory: string): Promise<string | undefined> {
  let dir = resolve(directory);
  while (!existsSync(dir)) dir = dirname(dir);
  try {
    const result = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    return result.code === 0 ? result.output.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The nearest pnpm, npm, Yarn or Bun workspace root above `directory`, if any. */
export function enclosingWorkspace(directory: string): string | undefined {
  let dir = dirname(resolve(directory));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) return dir;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const GIT_IDENTITY = [
  '-c',
  'user.name=create-cogitator-app',
  '-c',
  'user.email=create-cogitator-app@localhost',
];

async function gitHasIdentity(cwd: string): Promise<boolean> {
  const name = await runCommand('git', ['config', 'user.name'], { cwd });
  const email = await runCommand('git', ['config', 'user.email'], { cwd });
  return (
    name.code === 0 && email.code === 0 && name.output.trim() !== '' && email.output.trim() !== ''
  );
}

async function initGit(directory: string): Promise<StepResult> {
  if (!(await hasCommand('git', directory)))
    return { status: 'skipped', reason: 'git is not installed' };
  const repo = await enclosingGitRepo(directory);
  if (repo) {
    return { status: 'skipped', reason: `the project is inside the git repository at ${repo}` };
  }
  for (const args of [
    ['init', '--quiet'],
    ['add', '-A'],
  ]) {
    const result = await runCommand('git', args, { cwd: directory });
    if (result.code !== 0)
      return failure(new Error(`git ${args[0]} failed:\n${tail(result.output)}`));
  }
  const identity = (await gitHasIdentity(directory)) ? [] : GIT_IDENTITY;
  const commit = await runCommand(
    'git',
    [...identity, 'commit', '--quiet', '-m', 'feat: initial project from create-cogitator-app'],
    { cwd: directory }
  );
  if (commit.code !== 0) return failure(new Error(`git commit failed:\n${tail(commit.output)}`));
  return { status: 'done' };
}

export async function installDependencies(
  directory: string,
  pm: PackageManager,
  inherit: boolean
): Promise<StepResult> {
  if (!(await hasCommand(pm, directory))) {
    return failure(new Error(`${pm} is not installed, install it or pick another one with --pm`));
  }
  try {
    const result = await runCommand(pm, ['install'], { cwd: directory, inherit });
    if (result.code !== 0) {
      return failure(
        new Error(`${installCommand(pm)} exited with ${result.code}:\n${tail(result.output)}`)
      );
    }
    return { status: 'done' };
  } catch (error) {
    return failure(error);
  }
}

export function assertEmptyDirectory(directory: string): void {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`${directory} already exists and is not empty`);
  }
}

/**
 * Creates the project `spec` describes in `options.directory`, then installs
 * its dependencies, formats it and commits it to a new git repository. Throws
 * when the spec is invalid or the directory is taken. A failed install, format
 * or git step does not throw: the result reports it and the project stays.
 */
export async function scaffold(spec: unknown, options: ScaffoldOptions): Promise<ScaffoldResult> {
  const log = options.log ?? silentLogger;
  const directory = resolve(options.directory);
  const plan = planProject(spec, options);
  assertEmptyDirectory(directory);

  log.start('Writing project files');
  await mkdir(directory, { recursive: true });
  await writeFiles(directory, plan.files);
  log.done(`Wrote ${plan.files.length} files`);

  let install: StepResult = { status: 'skipped', reason: 'install was turned off' };
  if (options.install !== false) {
    log.start(`Installing dependencies with ${plan.spec.packageManager}`);
    install = await installDependencies(
      directory,
      plan.spec.packageManager,
      options.inheritOutput ?? false
    );
    if (install.status === 'done') log.done('Installed dependencies');
    else
      log.fail(
        `Could not install dependencies, run "${installCommand(plan.spec.packageManager)}" yourself`
      );
  }

  let format: StepResult = { status: 'skipped', reason: 'dependencies are not installed' };
  if (install.status === 'done') {
    log.start('Formatting the code');
    format = await formatProject(directory);
    if (format.status === 'done') log.done('Formatted the code');
    else if (format.status === 'failed') log.warn(format.error.message);
  }

  await writeLock(
    directory,
    plan.files.map((file) => file.path)
  );

  let git: StepResult = { status: 'skipped', reason: 'git was turned off' };
  if (options.git !== false) {
    log.start('Creating a git repository');
    git = await initGit(directory);
    if (git.status === 'done') log.done('Created a git repository with the first commit');
    else if (git.status === 'skipped') log.done(`Skipped git: ${git.reason}`);
    else log.fail(git.error.message);
  }

  const parentWorkspace = enclosingWorkspace(directory);
  return {
    plan,
    directory,
    files: plan.files.map((file) => file.path),
    install,
    format,
    git,
    ...(parentWorkspace && { parentWorkspace }),
  };
}
