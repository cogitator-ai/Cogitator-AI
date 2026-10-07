import { relative } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { IncompatibleSpecError } from '../kit/compat.js';
import { checkApiKey, describeKeyCheck } from '../kit/key-check.js';
import {
  hasOllamaModel,
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaUrl,
} from '../kit/ollama.js';
import { detectPackageManager, detectPackageManagerSpec } from '../kit/package-manager.js';
import { planProject, type ProjectPlan } from '../kit/plan.js';
import { PRESETS } from '../kit/presets.js';
import { providerInfo } from '../kit/providers.js';
import {
  scaffold,
  type ScaffoldLogger,
  type ScaffoldResult,
  type StepResult,
} from '../kit/scaffold.js';
import { bareModel } from '../kit/spec.js';
import { scaffolderVersion } from '../kit/versions.js';
import { DOCS_URL } from '../kit/guide.js';
import { CliError, isInteractive, parseCliArgs, type CliArgs } from './args.js';
import { helpText, presetList } from './help.js';
import { askMissing, CancelledError } from './interactive.js';
import { DEFAULT_DIRECTORY, resolveDirectory, specFromArgs } from './resolve.js';

interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function banner(version: string): string {
  return `\n  ${pc.bold(pc.cyan('create-cogitator-app'))} ${pc.dim(`v${version}`)}  ${pc.dim('Build AI agents in minutes')}\n`;
}

function clackLogger(): ScaffoldLogger {
  const spinner = p.spinner();
  return {
    start: (message) => spinner.start(message),
    done: (message) => spinner.stop(message),
    fail: (message) => spinner.error(message),
    warn: (message) => p.log.warn(message),
  };
}

function stepJson(step: StepResult): Record<string, string> {
  if (step.status === 'failed') return { status: 'failed', error: step.error.message };
  if (step.status === 'skipped') return { status: 'skipped', reason: step.reason };
  return { status: 'done' };
}

function planJson(plan: ProjectPlan, directory: string) {
  return {
    directory,
    spec: plan.spec,
    command: plan.command,
    files: plan.files.map((file) => file.path),
    dependencies: plan.dependencies,
    devDependencies: plan.devDependencies,
    scripts: plan.scripts,
    services: plan.services,
    env: plan.env.map(({ name, required, secret, description }) => ({
      name,
      required,
      secret,
      description,
    })),
    warnings: plan.warnings,
  };
}

function fileTree(paths: readonly string[]): string {
  return paths
    .map(
      (path) =>
        `  ${pc.dim(path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '')}${path.slice(path.lastIndexOf('/') + 1)}`
    )
    .join('\n');
}

function describeDryRun(plan: ProjectPlan, directory: string): string {
  const deps = Object.entries(plan.dependencies).map(
    ([name, range]) => `  ${name} ${pc.dim(range)}`
  );
  const devDeps = Object.entries(plan.devDependencies).map(
    ([name, range]) => `  ${name} ${pc.dim(range)}`
  );
  return [
    `${pc.bold('Dry run:')} nothing was written. ${directory} would get:`,
    '',
    pc.bold(`Files (${plan.files.length})`),
    fileTree(plan.files.map((file) => file.path)),
    '',
    pc.bold('Dependencies'),
    ...deps,
    '',
    pc.bold('Dev dependencies'),
    ...devDeps,
    ...(plan.services.length > 0
      ? ['', pc.bold('Compose services'), `  ${plan.services.join(', ')}`]
      : []),
    ...(plan.env.length > 0
      ? [
          '',
          pc.bold('Environment'),
          ...plan.env.map((v) => `  ${v.name}${v.required ? '' : pc.dim(' (optional)')}`),
        ]
      : []),
    '',
    pc.bold('Recreate with'),
    `  ${plan.command}`,
    '',
  ].join('\n');
}

/** Pulls the project's Ollama model when it is missing and the user agrees, or reports it. */
async function prepareOllama(plan: ProjectPlan, interactive: boolean): Promise<boolean> {
  const model = bareModel(plan.spec);
  const baseUrl = resolveOllamaUrl();
  const installed = await listOllamaModels(baseUrl);
  if (!installed) {
    if (interactive)
      p.log.warn(
        `Ollama is not running at ${baseUrl}. Start it and pull ${model} before the first run.`
      );
    return false;
  }
  if (hasOllamaModel(installed, model)) return true;
  if (!interactive) return false;

  const pull = await p.confirm({
    message: `${model} is not in your Ollama yet. Pull it now?`,
    initialValue: true,
  });
  if (p.isCancel(pull) || !pull) return false;
  const spinner = p.spinner();
  spinner.start(`Pulling ${model}`);
  try {
    await pullOllamaModel(baseUrl, model, (status) =>
      spinner.message(`Pulling ${model}: ${status}`)
    );
    spinner.stop(`Pulled ${model}`);
    return true;
  } catch (error) {
    spinner.error(error instanceof Error ? error.message : `Could not pull ${model}`);
    return false;
  }
}

function outro(result: ScaffoldResult, args: CliArgs, modelReady: boolean): string {
  const directory = relative(process.cwd(), result.directory);
  const steps = result.plan.nextSteps({
    directory: directory || undefined,
    installed: result.install.status === 'done',
    keyWritten: args.apiKey !== undefined,
    modelReady,
  });
  return [
    `${pc.green('Your project is ready.')} Next:`,
    '',
    ...steps.map(
      (step) => `  ${pc.cyan(step.command)}${step.note ? pc.dim(`  # ${step.note}`) : ''}`
    ),
    '',
    pc.dim(`Read AGENTS.md for how it fits together. Docs: ${DOCS_URL}`),
  ].join('\n');
}

/** What `run` reaches the network with, replaceable in tests. */
export interface RunDeps {
  fetch?: typeof fetch;
}

/** Runs the scaffolder for `argv` and resolves with the exit code. */
export async function run(
  argv: readonly string[],
  io: Io = defaultIo,
  deps: RunDeps = {}
): Promise<number> {
  const version = scaffolderVersion();
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    return reportError(error, argv.includes('--json'), io);
  }

  if (args.help) {
    io.stdout(helpText(version));
    return 0;
  }
  if (args.version) {
    io.stdout(`${version}\n`);
    return 0;
  }
  if (args.listTemplates) {
    io.stdout(args.json ? `${JSON.stringify(PRESETS, null, 2)}\n` : presetList());
    return 0;
  }

  const interactive = isInteractive(args);
  try {
    if (interactive) {
      io.stderr(banner(version));
      p.intro(pc.cyan("Let's build something with agents"));
      args = await askMissing(args);
    }

    const { path: directory, name } = resolveDirectory(args.directory ?? DEFAULT_DIRECTORY);
    const packageManager = args.packageManager ?? detectPackageManager();
    const spec = specFromArgs(args, { name, packageManager });
    const envKey = providerInfo(spec.provider).envKey;
    const secrets = envKey && args.apiKey ? { [envKey]: args.apiKey } : {};
    const planOptions = {
      secrets,
      packageManagerSpec: detectPackageManagerSpec(spec.packageManager),
    };

    if (args.dryRun) {
      const plan = planProject(spec, planOptions);
      if (args.json)
        io.stdout(
          `${JSON.stringify({ ok: true, dryRun: true, ...planJson(plan, directory) }, null, 2)}\n`
        );
      else io.stdout(describeDryRun(plan, directory));
      return 0;
    }

    const result = await scaffold(spec, {
      ...planOptions,
      directory,
      install: args.install ?? true,
      git: args.git ?? true,
      log: args.json ? undefined : clackLogger(),
    });

    const modelReady =
      result.plan.spec.provider === 'ollama' ? await prepareOllama(result.plan, interactive) : true;

    const key = envKey ? (args.apiKey ?? process.env[envKey]) : undefined;
    const provider = result.plan.spec.provider;
    let keyCheck: string | undefined;
    if (envKey && key && provider !== 'ollama') {
      keyCheck = describeKeyCheck(envKey, await checkApiKey(provider, key, { fetch: deps.fetch }));
    }

    if (args.json) {
      io.stdout(
        `${JSON.stringify(
          {
            ok: true,
            dryRun: false,
            ...planJson(result.plan, result.directory),
            steps: {
              install: stepJson(result.install),
              format: stepJson(result.format),
              git: stepJson(result.git),
            },
            modelReady,
            ...(keyCheck && { keyCheck }),
            ...(result.parentWorkspace && { parentWorkspace: result.parentWorkspace }),
          },
          null,
          2
        )}\n`
      );
      return 0;
    }

    if (keyCheck) p.log.info(keyCheck);
    if (result.parentWorkspace) {
      p.log.info(
        `The project is inside the workspace at ${result.parentWorkspace}. Add ${relative(result.parentWorkspace, result.directory)} to its workspace packages to share one install.`
      );
    }
    for (const warning of result.plan.warnings) p.log.warn(warning);
    if (interactive) p.outro(outro(result, args, modelReady));
    else io.stderr(`${outro(result, args, modelReady)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      p.cancel('Cancelled, nothing was created.');
      return 1;
    }
    return reportError(error, args.json, io);
  }
}

function reportError(error: unknown, json: boolean, io: Io): number {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    const issues = error instanceof IncompatibleSpecError ? error.issues : undefined;
    io.stdout(
      `${JSON.stringify({ ok: false, error: { message, ...(issues && { issues }) } }, null, 2)}\n`
    );
  } else if (error instanceof CliError || error instanceof IncompatibleSpecError) {
    io.stderr(`${pc.red('Error:')} ${message}\n`);
  } else {
    io.stderr(`${pc.red('Error:')} ${message}\n`);
    if (process.env.DEBUG && error instanceof Error && error.stack) io.stderr(`${error.stack}\n`);
  }
  return 1;
}
