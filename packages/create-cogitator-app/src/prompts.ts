import * as p from '@clack/prompts';
import path from 'node:path';
import type { LLMProvider, PackageManager, ProjectOptions, Template } from './types.js';
import { templateChoices } from './templates/index.js';
import { detectPackageManager } from './utils/package-manager.js';
import { defaultModels } from './utils/providers.js';
import { projectNameFromDirectory, validateProjectName } from './utils/project-name.js';
import { hasOllamaModel, listOllamaModels, resolveOllamaUrl } from './utils/ollama.js';

interface ParsedArgs {
  name?: string;
  template?: Template;
  provider?: LLMProvider;
  model?: string;
  packageManager?: PackageManager;
  docker?: boolean;
  git?: boolean;
  install?: boolean;
  yes?: boolean;
}

const validTemplates: Template[] = ['basic', 'memory', 'swarm', 'workflow', 'api-server', 'nextjs'];
const validProviders: LLMProvider[] = ['ollama', 'openai', 'anthropic', 'google'];
const validPMs: PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun'];

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--template' || arg === '-t') {
      if (i + 1 < args.length) {
        const val = args[++i] as Template;
        if (validTemplates.includes(val)) parsed.template = val;
      }
    } else if (arg === '--provider' || arg === '-p') {
      if (i + 1 < args.length) {
        const val = args[++i] as LLMProvider;
        if (validProviders.includes(val)) parsed.provider = val;
      }
    } else if (arg === '--model') {
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith('-')) {
        parsed.model = val;
        i++;
      }
    } else if (arg === '--pm') {
      if (i + 1 < args.length) {
        const val = args[++i] as PackageManager;
        if (validPMs.includes(val)) parsed.packageManager = val;
      }
    } else if (arg === '--docker') {
      parsed.docker = true;
    } else if (arg === '--no-docker') {
      parsed.docker = false;
    } else if (arg === '--git') {
      parsed.git = true;
    } else if (arg === '--no-git') {
      parsed.git = false;
    } else if (arg === '--install') {
      parsed.install = true;
    } else if (arg === '--no-install') {
      parsed.install = false;
    } else if (arg === '-y' || arg === '--yes') {
      parsed.yes = true;
    } else if (!arg.startsWith('-') && !parsed.name) {
      parsed.name = arg;
    }
  }

  return parsed;
}

/** What `--yes` answers, and what each prompt suggests. */
export const defaultAnswers = {
  name: 'my-agents',
  template: 'basic',
  provider: 'ollama',
  docker: true,
  git: true,
} as const satisfies Partial<ProjectOptions>;

function unlessCancelled<T>(answer: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(answer)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }
  return answer;
}

function validateDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.trim()) return 'Project name is required';
  return validateProjectName(projectNameFromDirectory(value));
}

function formatSize(bytes: number): string | undefined {
  return bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : undefined;
}

/**
 * Asks which local model the agents should use, offering the recommended one and
 * the ones already installed. Returns `undefined` without asking when Ollama does
 * not answer, which leaves the recommended model in place.
 */
async function promptOllamaModel(): Promise<string | undefined> {
  const installed = await listOllamaModels(resolveOllamaUrl());
  if (!installed) return undefined;

  const recommended = defaultModels.ollama;
  const others = installed.filter((model) => !hasOllamaModel([model], recommended));

  return unlessCancelled(
    await p.select<string>({
      message: 'Which Ollama model?',
      options: [
        {
          value: recommended,
          label: recommended,
          hint: hasOllamaModel(installed, recommended)
            ? 'recommended, installed'
            : 'recommended, not installed yet',
        },
        ...others.map((model) => ({
          value: model.name,
          label: model.name,
          hint: formatSize(model.size),
        })),
      ],
      initialValue: recommended,
    })
  );
}

/**
 * Turn the parsed arguments into project options, asking for whatever they leave
 * out; with `--yes` nothing is asked and the defaults fill the gaps.
 */
export async function collectOptions(args: ParsedArgs): Promise<ProjectOptions> {
  const interactive = !args.yes;

  const directory = (
    args.name ||
    (interactive
      ? unlessCancelled(
          await p.text({
            message: 'Where should we create your project?',
            placeholder: `./${defaultAnswers.name}`,
            defaultValue: defaultAnswers.name,
            validate: validateDirectory,
          })
        )
      : defaultAnswers.name)
  ).trim();

  const projectPath = path.resolve(process.cwd(), directory);
  const projectName = projectNameFromDirectory(directory);
  const nameError = validateProjectName(projectName);
  if (nameError) {
    throw new Error(`Invalid project name "${projectName}": ${nameError}`);
  }

  const template =
    args.template ??
    (interactive
      ? unlessCancelled(
          await p.select<Template>({
            message: 'Which template would you like?',
            options: templateChoices,
            initialValue: defaultAnswers.template,
          })
        )
      : defaultAnswers.template);

  const provider =
    args.provider ??
    (interactive
      ? unlessCancelled(
          await p.select<LLMProvider>({
            message: 'Which LLM provider?',
            options: [
              {
                value: 'ollama',
                label: 'Ollama',
                hint: `${defaultModels.ollama}, local, free, requires Ollama installed`,
              },
              { value: 'openai', label: 'OpenAI', hint: defaultModels.openai },
              { value: 'anthropic', label: 'Anthropic', hint: defaultModels.anthropic },
              { value: 'google', label: 'Google Gemini', hint: defaultModels.google },
            ],
            initialValue: defaultAnswers.provider,
          })
        )
      : defaultAnswers.provider);

  const model =
    args.model ?? (interactive && provider === 'ollama' ? await promptOllamaModel() : undefined);

  const packageManager =
    args.packageManager ??
    (interactive
      ? unlessCancelled(
          await p.select<PackageManager>({
            message: 'Package manager?',
            options: [
              { value: 'pnpm', label: 'pnpm' },
              { value: 'npm', label: 'npm' },
              { value: 'yarn', label: 'yarn' },
              { value: 'bun', label: 'bun' },
            ],
            initialValue: detectPackageManager(),
          })
        )
      : detectPackageManager());

  const docker =
    args.docker ??
    (interactive
      ? unlessCancelled(
          await p.confirm({
            message:
              'Include Docker Compose? (Redis + Postgres' +
              (provider === 'ollama' ? ' + Ollama)' : ')'),
            initialValue: defaultAnswers.docker,
          })
        )
      : defaultAnswers.docker);

  const git =
    args.git ??
    (interactive
      ? unlessCancelled(
          await p.confirm({
            message: 'Initialize git repository?',
            initialValue: defaultAnswers.git,
          })
        )
      : defaultAnswers.git);

  return {
    name: projectName,
    path: projectPath,
    template,
    provider,
    ...(model !== undefined && { model }),
    packageManager,
    docker,
    git,
    ...(args.install !== undefined && { install: args.install }),
  };
}
