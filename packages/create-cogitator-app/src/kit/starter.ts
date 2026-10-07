import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  exampleRef,
  fetchExampleFiles,
  findExample,
  parseExampleArgument,
  planExample,
  type ExamplePlan,
} from './examples.js';
import { installCommand, runScript } from './package-manager.js';
import {
  describeTemplate,
  downloadTemplate,
  prepareTemplate,
  type DownloadResult,
  type PreparedTemplate,
  type RemoteTemplate,
} from './remote.js';
import {
  assertEmptyDirectory,
  initGit,
  installDependencies,
  silentLogger,
  writeFiles,
  type ScaffoldLogger,
  type StepResult,
} from './scaffold.js';
import type { PackageManager } from './spec.js';
import type { NextStep } from './project.js';
import { scaffolderVersion } from './versions.js';

export interface StarterOptions {
  directory: string;
  name: string;
  packageManager: PackageManager;
  install?: boolean;
  git?: boolean;
  log?: ScaffoldLogger;
  inheritOutput?: boolean;
  fetch?: typeof fetch;
}

/** A project made from an example or a remote template instead of the generator. */
export interface StarterResult {
  directory: string;
  /** Where it came from: `example core/basic-agent at create-cogitator-app@0.4.0` or `github:owner/repo`. */
  source: string;
  files: string[];
  packageManager: PackageManager;
  install: StepResult;
  git: StepResult;
  /** Commands to the first run. */
  nextSteps: NextStep[];
  notes: string[];
}

async function finish(
  directory: string,
  packageManager: PackageManager,
  options: StarterOptions
): Promise<Pick<StarterResult, 'install' | 'git'>> {
  const log = options.log ?? silentLogger;
  let install: StepResult = { status: 'skipped', reason: 'install was turned off' };
  if (options.install !== false) {
    log.start(`Installing dependencies with ${packageManager}`);
    install = await installDependencies(directory, packageManager, options.inheritOutput ?? false);
    if (install.status === 'done') log.done('Installed dependencies');
    else
      log.fail(`Could not install dependencies, run "${installCommand(packageManager)}" yourself`);
  }
  let git: StepResult = { status: 'skipped', reason: 'git was turned off' };
  if (options.git !== false) {
    git = await initGit(directory);
    if (git.status === 'done') log.done('Created a git repository with the first commit');
    else if (git.status === 'failed') log.fail(git.error.message);
  }
  return { install, git };
}

function stepsFor(
  directory: string,
  packageManager: PackageManager,
  scripts: Record<string, string>,
  installed: boolean,
  needsEnv: boolean
): NextStep[] {
  const where = relative(process.cwd(), directory);
  const steps: NextStep[] = where
    ? [{ command: `cd ${/^[\w./-]+$/.test(where) ? where : JSON.stringify(where)}` }]
    : [];
  if (!installed) steps.push({ command: installCommand(packageManager) });
  if (needsEnv) steps.push({ command: 'cp .env.example .env', note: 'then fill in the keys' });
  const run = ['dev', 'start'].find((script) => scripts[script]);
  if (run) steps.push({ command: runScript(packageManager, run) });
  return steps;
}

/** The project `--example` describes, before anything is fetched or written. */
export function resolveExample(
  argument: string,
  options: Pick<StarterOptions, 'name' | 'packageManager'> & { secrets?: Record<string, string> }
): ExamplePlan {
  const { query, ref } = parseExampleArgument(argument);
  const version = scaffolderVersion();
  return planExample(findExample(query), {
    name: options.name,
    packageManager: options.packageManager,
    version,
    ref: ref ?? exampleRef(version),
    secrets: options.secrets,
  });
}

/**
 * Creates a project from an example of the Cogitator repo: its files at the
 * tag of this scaffolder version (or the ref after `#`), with a package.json,
 * tsconfig, .env.example and README around them.
 */
export async function createFromExample(
  plan: ExamplePlan,
  options: StarterOptions
): Promise<StarterResult> {
  const log = options.log ?? silentLogger;
  const directory = resolve(options.directory);
  assertEmptyDirectory(directory);

  log.start(`Downloading the ${plan.example.name} example from ${plan.ref}`);
  const fetched = await fetchExampleFiles(plan, options.fetch);
  await mkdir(directory, { recursive: true });
  const files = [...plan.files, ...fetched];
  await writeFiles(directory, files);
  log.done(`Wrote ${files.length} files`);

  const { install, git } = await finish(directory, options.packageManager, options);
  return {
    directory,
    source: `example ${plan.example.name} at ${plan.ref}`,
    files: files.map((file) => file.path).sort(),
    packageManager: options.packageManager,
    install,
    git,
    nextSteps: stepsFor(
      directory,
      options.packageManager,
      plan.scripts,
      install.status === 'done',
      plan.example.env.length > 0
    ),
    notes: [],
  };
}

/**
 * Creates a project from a GitHub repository or a directory of one. The
 * repository's lockfile decides the package manager when it has one.
 * Nothing is left behind when the download fails.
 */
export async function createFromTemplate(
  template: RemoteTemplate,
  options: StarterOptions & { token?: string }
): Promise<StarterResult> {
  const log = options.log ?? silentLogger;
  const directory = resolve(options.directory);
  assertEmptyDirectory(directory);
  const existed = existsSync(directory);

  log.start(`Downloading ${describeTemplate(template)}`);
  let downloaded: DownloadResult;
  let prepared: PreparedTemplate;
  try {
    downloaded = await downloadTemplate(template, directory, {
      fetch: options.fetch,
      token: options.token,
    });
    prepared = prepareTemplate(directory, { name: options.name });
  } catch (error) {
    log.fail(`Could not use ${describeTemplate(template)}`);
    if (existed) {
      for (const entry of await readdir(directory)) {
        await rm(join(directory, entry), { recursive: true, force: true });
      }
    } else {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
  log.done(`Wrote ${downloaded.files.length} files`);

  const packageManager = prepared.packageManager ?? options.packageManager;
  const notes = [
    ...(prepared.packageManager && prepared.packageManager !== options.packageManager
      ? [
          `The template has a ${prepared.packageManager} lockfile, so it uses ${prepared.packageManager}`,
        ]
      : []),
    ...(prepared.rewritten.length > 0
      ? [
          `Pinned ${prepared.rewritten.join(', ')} to the versions released with create-cogitator-app@${scaffolderVersion()}`,
        ]
      : []),
    ...(downloaded.skipped.length > 0
      ? [`Left out links and special files: ${downloaded.skipped.join(', ')}`]
      : []),
  ];
  const { install, git } = await finish(directory, packageManager, options);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return {
    directory,
    source: describeTemplate(template),
    files: downloaded.files,
    packageManager,
    install,
    git,
    nextSteps: stepsFor(
      directory,
      packageManager,
      manifest.scripts ?? {},
      install.status === 'done',
      existsSync(join(directory, '.env.example'))
    ),
    notes,
  };
}
