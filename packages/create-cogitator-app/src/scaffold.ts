import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import type { ProjectOptions, ScaffoldResult, ScaffoldStep, TemplateFile } from './types.js';
import { getTemplate } from './templates/index.js';
import { generateTsconfig } from './templates/base/tsconfig.js';
import { generateGitignore } from './templates/base/gitignore.js';
import { generateEnvExample } from './templates/base/env-example.js';
import { generateDockerCompose } from './templates/base/docker-compose.js';
import { generateCogitatorYml } from './templates/base/cogitator-yml.js';
import { generateReadme } from './templates/base/readme.js';
import { generatePnpmWorkspace } from './templates/base/pnpm-workspace.js';
import { installDependencies } from './utils/package-manager.js';
import { initGitRepo, isGitInstalled } from './utils/git.js';
import { validateProjectName } from './utils/project-name.js';
import { modelFor } from './utils/providers.js';

/** The Node.js versions generated projects run on: `--env-file-if-exists` in their scripts needs 22.9+. */
const NODE_ENGINES = '>=22.12.0';

function writeFile(basePath: string, file: TemplateFile) {
  const fullPath = path.join(basePath, file.path);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, file.content, 'utf-8');
}

function buildPackageJson(options: ProjectOptions): string {
  const template = getTemplate(options.template);
  const isNextjs = options.template === 'nextjs';

  const pkg: Record<string, unknown> = {
    name: options.name,
    version: '0.1.0',
    private: true,
    ...(isNextjs ? {} : { type: 'module' }),
    engines: { node: NODE_ENGINES },
    scripts: template.scripts(),
    dependencies: template.dependencies(),
    devDependencies: template.devDependencies(),
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

function collectFiles(options: ProjectOptions): TemplateFile[] {
  const template = getTemplate(options.template);
  const files: TemplateFile[] = [];

  files.push({ path: 'package.json', content: buildPackageJson(options) });
  files.push(...template.files(options));
  files.push(generateGitignore(options.template));
  files.push(generateEnvExample(options.provider, options.template));
  files.push(generateCogitatorYml(options.provider, options.template, modelFor(options)));
  files.push(generateReadme(options));

  if (options.template !== 'nextjs') {
    files.push(generateTsconfig());
  }

  if (options.packageManager === 'pnpm') {
    files.push(generatePnpmWorkspace());
  }

  if (options.docker) {
    files.push(generateDockerCompose(options.provider, modelFor(options)));
  }

  return files;
}

function runStep(
  spinner: ReturnType<typeof p.spinner>,
  messages: { start: string; done: string; failed: string },
  step: () => void
): ScaffoldStep {
  spinner.start(messages.start);
  try {
    step();
    spinner.stop(messages.done);
    return { status: 'done' };
  } catch (error) {
    spinner.stop(messages.failed);
    return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Writes the project described by `options`, then installs its dependencies
 * (unless `install` is `false`) and initializes git (when `git` is `true`).
 * Throws when `name` is not a valid package name or `path` exists and is not
 * empty. A failed install or git step does not throw: the result reports it,
 * and the project stays written.
 */
export async function scaffold(options: ProjectOptions): Promise<ScaffoldResult> {
  const nameError = validateProjectName(options.name);
  if (nameError) {
    throw new Error(`Invalid project name "${options.name}": ${nameError}`);
  }
  if (fs.existsSync(options.path) && fs.readdirSync(options.path).length > 0) {
    throw new Error(`Directory "${options.path}" already exists and is not empty`);
  }

  const s = p.spinner();

  s.start('Generating project files');
  const files = collectFiles(options);

  fs.mkdirSync(options.path, { recursive: true });
  for (const file of files) {
    writeFile(options.path, file);
  }
  s.stop('Generated project files');

  const install: ScaffoldStep =
    options.install === false
      ? { status: 'skipped' }
      : runStep(
          s,
          {
            start: 'Installing dependencies',
            done: 'Installed dependencies',
            failed: `Failed to install dependencies, run "${options.packageManager} install" yourself`,
          },
          () => installDependencies(options.path, options.packageManager)
        );

  const git: ScaffoldStep =
    options.git && isGitInstalled()
      ? runStep(
          s,
          {
            start: 'Initializing git repository',
            done: 'Initialized git repository',
            failed: 'Failed to initialize git, run "git init" yourself',
          },
          () => initGitRepo(options.path)
        )
      : { status: 'skipped' };

  return { files: files.map((file) => file.path), install, git };
}
