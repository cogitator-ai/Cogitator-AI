import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, basename, relative } from 'node:path';
import { validateSkill } from '@cogitator-ai/core';
import type { Skill, Tool } from '@cogitator-ai/types';
import { log } from '../utils/logger.js';
import { importUserModule } from '../utils/module-loader.js';

const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const INSTALLED_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_FILES = ['skill.ts', 'skill.js', 'skill.mjs'];
export const SKILL_TEMPLATES = ['basic', 'device', 'api'] as const;
export type SkillTemplate = (typeof SKILL_TEMPLATES)[number];

function globalSkillsDir(): string {
  return resolve(homedir(), '.cogitator', 'skills');
}

function localSkillsDir(): string {
  return resolve(process.cwd(), 'skills');
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

export function isSafeSkillDirName(name: string): boolean {
  return INSTALLED_SKILL_NAME.test(name) && !name.includes('..');
}

function parseInstalledSkillName(value: string): string {
  if (isSafeSkillDirName(value)) return value;
  throw new InvalidArgumentError('Skill name must be a plain directory name.');
}

function parseSkillName(value: string): string {
  if (isValidSkillName(value)) return value;
  throw new InvalidArgumentError(
    'Skill names must be kebab-case: lowercase letters, digits and single dashes (e.g. "weather-api").'
  );
}

function parseTemplate(value: string): SkillTemplate {
  const template = SKILL_TEMPLATES.find((t) => t === value);
  if (template) return template;
  throw new InvalidArgumentError(`Expected one of: ${SKILL_TEMPLATES.join(', ')}.`);
}

export function findSkillFile(dir: string): string | null {
  for (const file of SKILL_FILES) {
    const full = resolve(dir, file);
    if (existsSync(full)) return full;
  }
  return null;
}

interface SkillMeta {
  name: string;
  location: 'local' | 'global';
  path: string;
}

function discoverSkills(): SkillMeta[] {
  const skills: SkillMeta[] = [];
  const locations: Array<[string, SkillMeta['location']]> = [
    [localSkillsDir(), 'local'],
    [globalSkillsDir(), 'global'],
  ];

  for (const [dir, location] of locations) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = resolve(dir, entry.name);
      if (findSkillFile(skillDir)) {
        skills.push({ name: entry.name, location, path: skillDir });
      }
    }
  }

  return skills;
}

function isTool(value: unknown): value is Tool {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'execute' in value &&
    typeof value.execute === 'function'
  );
}

function optionalString(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' ? field : undefined;
}

function optionalStringArray(value: object, key: string): string[] | undefined {
  const field: unknown = Reflect.get(value, key);
  return Array.isArray(field) && field.every((v) => typeof v === 'string') ? field : undefined;
}

export function toSkill(value: unknown): { skill: Skill | null; issues: string[] } {
  if (typeof value !== 'object' || value === null) {
    return { skill: null, issues: ['Export is not an object'] };
  }

  const issues: string[] = [];
  const name = optionalString(value, 'name');
  const version = optionalString(value, 'version');
  const description = optionalString(value, 'description');
  const tools: unknown = Reflect.get(value, 'tools');

  if (!name) issues.push('Missing or invalid "name" field');
  if (!version) issues.push('Missing or invalid "version" field');
  if (description === undefined) issues.push('Missing or invalid "description" field');
  if (!Array.isArray(tools)) {
    issues.push('Missing or invalid "tools" array');
  } else {
    tools.forEach((tool, index) => {
      if (!isTool(tool)) issues.push(`tools[${index}] is not a valid tool (needs name + execute)`);
    });
  }

  if (issues.length > 0 || !name || !version || description === undefined) {
    return { skill: null, issues };
  }

  return {
    skill: {
      name,
      version,
      description,
      tools: Array.isArray(tools) ? tools.filter(isTool) : [],
      instructions: optionalString(value, 'instructions'),
      env: optionalStringArray(value, 'env'),
      dependencies: optionalStringArray(value, 'dependencies'),
    },
    issues,
  };
}

export function findMissingDependencies(
  dependencies: readonly string[],
  fromFile: string
): string[] {
  const require = createRequire(fromFile);
  return dependencies.filter((dep) => {
    try {
      require.resolve(dep);
      return false;
    } catch {
      return true;
    }
  });
}

export const skillCommand = new Command('skill').description('Manage agent skills');

skillCommand
  .command('list')
  .description('List installed skills')
  .action(() => {
    const skills = discoverSkills();

    if (skills.length === 0) {
      log.info('No skills installed');
      log.dim('  cogitator skill create <name>   Create a new skill');
      log.dim('  cogitator skill add <path>      Install from path');
      return;
    }

    console.log();
    console.log(chalk.bold('  Installed Skills'));
    console.log();

    for (const skill of skills) {
      const badge = skill.location === 'local' ? chalk.blue(' local') : chalk.dim(' global');
      console.log(`  ${chalk.green('●')} ${chalk.bold(skill.name)}${badge}`);
      console.log(`    ${chalk.dim(skill.path)}`);
    }

    console.log();
    console.log(chalk.dim(`  ${skills.length} skill${skills.length !== 1 ? 's' : ''} found`));
    console.log();
  });

skillCommand
  .command('add <source>')
  .description('Install a skill from a local path or directory')
  .option('-g, --global', 'Install globally', false)
  .action((source: string, options: { global: boolean }) => {
    const sourcePath = resolve(process.cwd(), source);

    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      log.error(`Source is not a directory: ${sourcePath}`);
      process.exit(1);
    }

    if (!findSkillFile(sourcePath)) {
      log.error(`No ${SKILL_FILES.join(' / ')} found in ${sourcePath}`);
      process.exit(1);
    }

    const name = basename(sourcePath);
    if (!isSafeSkillDirName(name)) {
      log.error(`Invalid skill directory name "${name}"`);
      process.exit(1);
    }

    const targetDir = options.global ? globalSkillsDir() : localSkillsDir();
    const targetPath = resolve(targetDir, name);

    if (existsSync(targetPath)) {
      log.error(`Skill "${name}" already exists at ${targetPath}`);
      log.dim('Remove it first: cogitator skill remove ' + name);
      process.exit(1);
    }

    mkdirSync(targetDir, { recursive: true });
    cpSync(sourcePath, targetPath, {
      recursive: true,
      filter: (src) => !relative(sourcePath, src).split(/[\\/]/).includes('node_modules'),
    });

    log.success(`Skill "${name}" installed to ${options.global ? 'global' : 'local'} skills`);
    log.dim(targetPath);
  });

skillCommand
  .command('remove')
  .argument('<name>', 'Skill name', parseInstalledSkillName)
  .description('Remove an installed skill')
  .option('-g, --global', 'Remove from global skills', false)
  .action((name: string, options: { global: boolean }) => {
    const dirs = options.global ? [globalSkillsDir()] : [localSkillsDir(), globalSkillsDir()];

    for (const dir of dirs) {
      const skillPath = resolve(dir, name);
      if (existsSync(skillPath) && findSkillFile(skillPath)) {
        rmSync(skillPath, { recursive: true, force: true });
        log.success(`Skill "${name}" removed from ${skillPath}`);
        return;
      }
    }

    log.error(`Skill "${name}" not found`);
    log.dim('Run "cogitator skill list" to see installed skills');
    process.exit(1);
  });

skillCommand
  .command('create')
  .argument('<name>', 'Skill name (kebab-case)', parseSkillName)
  .description('Scaffold a new skill')
  .option('-g, --global', 'Create in global skills directory', false)
  .option('-t, --template <type>', 'Template type (basic, device, api)', parseTemplate, 'basic')
  .action((name: string, options: { global: boolean; template: SkillTemplate }) => {
    const targetDir = options.global ? globalSkillsDir() : localSkillsDir();
    const skillDir = resolve(targetDir, name);

    if (existsSync(skillDir)) {
      log.error(`Skill "${name}" already exists at ${skillDir}`);
      process.exit(1);
    }

    mkdirSync(resolve(skillDir, 'tools'), { recursive: true });

    const templates = getTemplate(name, options.template);

    writeFileSync(resolve(skillDir, 'skill.ts'), templates.skill);
    writeFileSync(resolve(skillDir, 'tools', `${name}.ts`), templates.tool);

    log.success(`Skill "${name}" created at ${skillDir}`);
    console.log();
    log.dim('  Files:');
    log.dim(`    ${resolve(skillDir, 'skill.ts')}`);
    log.dim(`    ${resolve(skillDir, 'tools', `${name}.ts`)}`);
    console.log();
    log.dim('  Next steps:');
    log.dim('    1. Edit the tool implementation');
    log.dim('    2. Update skill.ts with instructions');
    log.dim(`    3. Add to your agent's skills array`);
    console.log();
  });

skillCommand
  .command('validate [path]')
  .description('Validate a skill definition')
  .action(async (path?: string) => {
    const skillPath = path ? resolve(process.cwd(), path) : process.cwd();
    const skillFile = findSkillFile(skillPath);

    if (!skillFile) {
      log.error(`No ${SKILL_FILES.join(' / ')} found`);
      log.dim(`Searched in: ${skillPath}`);
      process.exit(1);
    }

    log.step(`Validating ${chalk.dim(skillFile)}`);

    let exported: unknown;
    try {
      const mod = await importUserModule(skillFile, process.cwd());
      exported = mod.default ?? mod.skill;
    } catch (err) {
      log.error(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (exported === undefined) {
      log.error('Skill file must export a default or named "skill" export');
      process.exit(1);
    }

    const { skill, issues } = toSkill(exported);
    const warnings: string[] = [];

    if (skill) {
      const result = validateSkill({ ...skill, dependencies: undefined });
      issues.push(...result.errors);
      warnings.push(...result.warnings);
      const missingDeps = findMissingDependencies(skill.dependencies ?? [], skillFile);
      if (missingDeps.length > 0) {
        issues.push(`Missing dependencies: ${missingDeps.join(', ')}`);
      }
    }

    for (const warning of warnings) {
      console.log(`  ${chalk.yellow('!')} ${warning}`);
    }

    if (!skill || issues.length > 0) {
      log.warn(`Found ${issues.length} issue${issues.length !== 1 ? 's' : ''}:`);
      for (const issue of issues) {
        console.log(`  ${chalk.red('✗')} ${issue}`);
      }
      process.exit(1);
    }

    log.success('Skill is valid');
    console.log(`  ${chalk.bold('Name')}          ${skill.name}`);
    console.log(`  ${chalk.bold('Version')}       ${skill.version}`);
    console.log(`  ${chalk.bold('Tools')}         ${skill.tools.length}`);
    if (skill.instructions) {
      console.log(`  ${chalk.bold('Instructions')}  ${skill.instructions.length} chars`);
    }
  });

interface TemplateFiles {
  skill: string;
  tool: string;
}

export function getTemplate(name: string, template: SkillTemplate): TemplateFiles {
  const camelName = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const toolName = name.replace(/-/g, '_');
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  if (template === 'device') {
    return {
      skill: `import { defineSkill } from '@cogitator-ai/core';
import { ${camelName}Tool } from './tools/${name}.js';

export default defineSkill({
  name: '${name}',
  version: '1.0.0',
  description: 'Device control skill',
  tools: [${camelName}Tool],
  instructions: \`Use the ${toolName} tool when the user asks to interact with their device.\`,
});
`,
      tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const ${camelName}Tool = tool({
  name: '${toolName}',
  description: 'Interact with the device',
  parameters: z.object({
    action: z.string().describe('The action to perform'),
  }),
  execute: async ({ action }) => {
    return { action, result: 'not implemented' };
  },
});
`,
    };
  }

  if (template === 'api') {
    return {
      skill: `import { defineSkill } from '@cogitator-ai/core';
import { ${camelName}Tool } from './tools/${name}.js';

export default defineSkill({
  name: '${name}',
  version: '1.0.0',
  description: 'API integration skill',
  tools: [${camelName}Tool],
  env: ['${envName}'],
  instructions: \`Use the ${toolName} tool to interact with the ${name} API.\`,
});
`,
      tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const ${camelName}Tool = tool({
  name: '${toolName}',
  description: 'Call the ${name} API',
  parameters: z.object({
    query: z.string().describe('The query to send'),
  }),
  execute: async ({ query }) => {
    const apiKey = process.env.${envName};
    if (!apiKey) throw new Error('${envName} is not configured');

    return { query, result: 'not implemented' };
  },
});
`,
    };
  }

  return {
    skill: `import { defineSkill } from '@cogitator-ai/core';
import { ${camelName}Tool } from './tools/${name}.js';

export default defineSkill({
  name: '${name}',
  version: '1.0.0',
  description: 'A custom skill',
  tools: [${camelName}Tool],
  instructions: \`Use the ${toolName} tool when appropriate.\`,
});
`,
    tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const ${camelName}Tool = tool({
  name: '${toolName}',
  description: 'Describe what this tool does so the model knows when to call it',
  parameters: z.object({
    input: z.string().describe('The input to process'),
  }),
  execute: async ({ input }) => {
    return { input, result: 'not implemented' };
  },
});
`,
  };
}
