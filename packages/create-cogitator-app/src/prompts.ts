import * as p from '@clack/prompts';
import path from 'node:path';
import type { LLMProvider, PackageManager, ProjectOptions, Template } from './types.js';
import { templateChoices } from './templates/index.js';
import { detectPackageManager } from './utils/package-manager.js';
import { defaultModels } from './utils/providers.js';

interface ParsedArgs {
  name?: string;
  template?: Template;
  provider?: LLMProvider;
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

/**
 * Turn the parsed arguments into project options, asking for whatever they leave
 * out; with `--yes` nothing is asked and the defaults fill the gaps.
 */
export async function collectOptions(args: ParsedArgs): Promise<ProjectOptions> {
  const interactive = !args.yes;

  const rawName =
    args.name ||
    (interactive
      ? unlessCancelled(
          await p.text({
            message: 'Where should we create your project?',
            placeholder: `./${defaultAnswers.name}`,
            defaultValue: defaultAnswers.name,
            validate: (value) => {
              if (value && !value.trim()) return 'Project name is required';
              return undefined;
            },
          })
        )
      : defaultAnswers.name);

  const name = rawName.trim();
  const projectName = path.basename(path.normalize(name).replace(/^\.\//, '').replace(/^\.\\/, ''));
  const projectPath = path.resolve(process.cwd(), name);

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
                hint: `${defaultModels.ollama} — local, free, requires Ollama installed`,
              },
              { value: 'openai', label: 'OpenAI', hint: defaultModels.openai },
              { value: 'anthropic', label: 'Anthropic', hint: defaultModels.anthropic },
              { value: 'google', label: 'Google Gemini', hint: defaultModels.google },
            ],
            initialValue: defaultAnswers.provider,
          })
        )
      : defaultAnswers.provider);

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
    packageManager,
    docker,
    git,
    ...(args.install !== undefined && { install: args.install }),
  };
}
