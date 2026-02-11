import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import type { ProjectOptions, TemplateFile } from './types.js';
import { getTemplate } from './templates/index.js';
import { generateTsconfig } from './templates/base/tsconfig.js';
import { generateGitignore } from './templates/base/gitignore.js';
import { generateEnvExample } from './templates/base/env-example.js';
import { generateDockerCompose } from './templates/base/docker-compose.js';
import { generateCogitatorYml } from './templates/base/cogitator-yml.js';
import { generateReadme } from './templates/base/readme.js';
import { installDependencies } from './utils/package-manager.js';
import { initGitRepo, isGitInstalled } from './utils/git.js';

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
  files.push(generateGitignore());
  files.push(generateEnvExample(options.provider));
  files.push(generateCogitatorYml(options.provider));
  files.push(generateReadme(options));

  if (options.template !== 'nextjs') {
    files.push(generateTsconfig());
  }

  if (options.docker) {
    files.push(generateDockerCompose(options.provider));
  }

  return files;
}

export async function scaffold(options: ProjectOptions) {
  const s = p.spinner();

  s.start('Generating project files');
  const files = collectFiles(options);

  fs.mkdirSync(options.path, { recursive: true });
  for (const file of files) {
    writeFile(options.path, file);
  }
  s.stop('Generated project files');

  s.start('Installing dependencies');
  try {
    installDependencies(options.path, options.packageManager);
    s.stop('Installed dependencies');
  } catch {
    s.stop('Failed to install dependencies — run manually');
  }

  if (options.git && isGitInstalled()) {
    s.start('Initializing git repository');
    try {
      initGitRepo(options.path);
      s.stop('Initialized git repository');
    } catch {
      s.stop('Failed to initialize git — run manually');
    }
  }
}
