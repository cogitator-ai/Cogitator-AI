import * as p from '@clack/prompts';
import path from 'node:path';
import type { LLMProvider, PackageManager, ProjectOptions, Template } from './types.js';
import { templateChoices } from './templates/index.js';
import { detectPackageManager } from './utils/package-manager.js';

interface ParsedArgs {
  name?: string;
  template?: Template;
  provider?: LLMProvider;
  packageManager?: PackageManager;
  docker?: boolean;
  git?: boolean;
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
    } else if (arg === '-y' || arg === '--yes') {
      parsed.yes = true;
    } else if (!arg.startsWith('-') && !parsed.name) {
      parsed.name = arg;
    }
  }

  return parsed;
}

export async function collectOptions(args: ParsedArgs): Promise<ProjectOptions> {
  const rawName =
    args.name ||
    ((await p.text({
      message: 'Where should we create your project?',
      placeholder: './my-agents',
      defaultValue: 'my-agents',
      validate: (value) => {
        if (!value.trim()) return 'Project name is required';
        return undefined;
      },
    })) as string);

  if (p.isCancel(rawName)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  const name = rawName.trim();
  const projectName = path.basename(path.normalize(name).replace(/^\.\//, '').replace(/^\.\\/, ''));
  const projectPath = path.resolve(process.cwd(), name);

  const template =
    args.template ||
    ((await p.select({
      message: 'Which template would you like?',
      options: templateChoices,
    })) as Template);

  if (p.isCancel(template)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  const provider =
    args.provider ||
    ((await p.select({
      message: 'Which LLM provider?',
      options: [
        {
          value: 'ollama' as const,
          label: 'Ollama',
          hint: 'local, free — requires Ollama installed',
        },
        { value: 'openai' as const, label: 'OpenAI', hint: 'GPT-4o' },
        { value: 'anthropic' as const, label: 'Anthropic', hint: 'Claude Sonnet' },
        { value: 'google' as const, label: 'Google Gemini', hint: 'Gemini 2.5 Flash' },
      ],
    })) as LLMProvider);

  if (p.isCancel(provider)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  const packageManager =
    args.packageManager ||
    ((await p.select({
      message: 'Package manager?',
      options: [
        { value: 'pnpm' as const, label: 'pnpm' },
        { value: 'npm' as const, label: 'npm' },
        { value: 'yarn' as const, label: 'yarn' },
        { value: 'bun' as const, label: 'bun' },
      ],
      initialValue: detectPackageManager(),
    })) as PackageManager);

  if (p.isCancel(packageManager)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  const docker =
    args.docker ??
    ((await p.confirm({
      message:
        'Include Docker Compose? (Redis + Postgres' + (provider === 'ollama' ? ' + Ollama)' : ')'),
      initialValue: true,
    })) as boolean);

  if (p.isCancel(docker)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  const git =
    args.git ??
    ((await p.confirm({
      message: 'Initialize git repository?',
      initialValue: true,
    })) as boolean);

  if (p.isCancel(git)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }

  return {
    name: projectName,
    path: projectPath,
    template,
    provider,
    packageManager,
    docker,
    git,
  };
}
