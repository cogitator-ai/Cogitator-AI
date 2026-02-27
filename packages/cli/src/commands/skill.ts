import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { log } from '../utils/logger.js';

const GLOBAL_SKILLS_DIR = resolve(process.env.HOME ?? '~', '.cogitator/skills');
const LOCAL_SKILLS_DIR = resolve(process.cwd(), 'skills');

interface SkillMeta {
  name: string;
  location: 'local' | 'global';
  path: string;
}

async function discoverSkills(): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];

  for (const dir of [LOCAL_SKILLS_DIR, GLOBAL_SKILLS_DIR]) {
    if (!existsSync(dir)) continue;
    const location = dir === LOCAL_SKILLS_DIR ? 'local' : 'global';

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = resolve(dir, entry.name);
      const hasSkillFile =
        existsSync(resolve(skillDir, 'skill.ts')) || existsSync(resolve(skillDir, 'skill.js'));

      if (hasSkillFile) {
        skills.push({ name: entry.name, location, path: skillDir });
      }
    }
  }

  return skills;
}

export const skillCommand = new Command('skill').description('Manage agent skills');

skillCommand
  .command('list')
  .description('List installed skills')
  .action(async () => {
    const skills = await discoverSkills();

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
  .action(async (source: string, options: { global: boolean }) => {
    const sourcePath = resolve(process.cwd(), source);

    if (!existsSync(sourcePath)) {
      log.error(`Source not found: ${sourcePath}`);
      process.exit(1);
    }

    const name = basename(sourcePath);
    const targetDir = options.global ? GLOBAL_SKILLS_DIR : LOCAL_SKILLS_DIR;
    const targetPath = resolve(targetDir, name);

    if (existsSync(targetPath)) {
      log.error(`Skill "${name}" already exists at ${targetPath}`);
      log.dim('Remove it first: cogitator skill remove ' + name);
      process.exit(1);
    }

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const { cpSync } = await import('node:fs');
    cpSync(sourcePath, targetPath, { recursive: true });

    log.success(`Skill "${name}" installed to ${options.global ? 'global' : 'local'} skills`);
    log.dim(targetPath);
  });

skillCommand
  .command('remove <name>')
  .description('Remove an installed skill')
  .option('-g, --global', 'Remove from global skills', false)
  .action((name: string, options: { global: boolean }) => {
    const dirs = options.global ? [GLOBAL_SKILLS_DIR] : [LOCAL_SKILLS_DIR, GLOBAL_SKILLS_DIR];

    for (const dir of dirs) {
      const skillPath = resolve(dir, name);
      if (existsSync(skillPath)) {
        rmSync(skillPath, { recursive: true, force: true });
        log.success(`Skill "${name}" removed from ${skillPath}`);
        return;
      }
    }

    log.error(`Skill "${name}" not found`);
    log.dim('Run "cogitator skill list" to see installed skills');
  });

skillCommand
  .command('create <name>')
  .description('Scaffold a new skill')
  .option('-g, --global', 'Create in global skills directory', false)
  .option('-t, --template <type>', 'Template type (basic, device, api)', 'basic')
  .action((name: string, options: { global: boolean; template: string }) => {
    const targetDir = options.global ? GLOBAL_SKILLS_DIR : LOCAL_SKILLS_DIR;
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
    log.dim(`    ${skillDir}/skill.ts`);
    log.dim(`    ${skillDir}/tools/${name}.ts`);
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

    const skillFile = existsSync(resolve(skillPath, 'skill.ts'))
      ? resolve(skillPath, 'skill.ts')
      : existsSync(resolve(skillPath, 'skill.js'))
        ? resolve(skillPath, 'skill.js')
        : null;

    if (!skillFile) {
      log.error('No skill.ts or skill.js found');
      log.dim(`Searched in: ${skillPath}`);
      process.exit(1);
    }

    log.step(`Validating ${chalk.dim(skillFile)}`);

    try {
      const mod = await import(`file://${skillFile}`);
      const skill = mod.default ?? mod.skill;

      if (!skill) {
        log.error('Skill file must export a default or named "skill" export');
        process.exit(1);
      }

      const issues: string[] = [];

      if (!skill.name || typeof skill.name !== 'string') {
        issues.push('Missing or invalid "name" field');
      }
      if (!skill.tools || !Array.isArray(skill.tools)) {
        issues.push('Missing or invalid "tools" array');
      }
      if (skill.env && Array.isArray(skill.env)) {
        for (const envVar of skill.env) {
          if (!process.env[envVar]) {
            issues.push(`Environment variable not set: ${envVar}`);
          }
        }
      }

      if (issues.length > 0) {
        log.warn(`Found ${issues.length} issue${issues.length !== 1 ? 's' : ''}:`);
        for (const issue of issues) {
          console.log(`  ${chalk.yellow('!')} ${issue}`);
        }
        process.exit(1);
      }

      log.success('Skill is valid');
      console.log(`  ${chalk.bold('Name')}    ${skill.name}`);
      console.log(`  ${chalk.bold('Tools')}   ${skill.tools.length}`);
      if (skill.instructions) {
        console.log(`  ${chalk.bold('Instructions')}  ${skill.instructions.length} chars`);
      }
    } catch (err) {
      log.error(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

interface TemplateFiles {
  skill: string;
  tool: string;
}

function getTemplate(name: string, template: string): TemplateFiles {
  const camelName = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

  if (template === 'device') {
    return {
      skill: `import { defineSkill } from '@cogitator-ai/core';
import { ${camelName}Tool } from './tools/${name}.js';

export default defineSkill({
  name: '${name}',
  version: '1.0.0',
  description: 'Device control skill',
  tools: [${camelName}Tool],
  instructions: \`Use the ${name} tool when the user asks to interact with their device.\`,
});
`,
      tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';

export const ${camelName}Tool = tool({
  name: '${name}',
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
  env: ['${name.toUpperCase().replace(/-/g, '_')}_API_KEY'],
  instructions: \`Use the ${name} tool to interact with the ${name} API.\`,
});
`,
      tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const ${camelName}Tool = tool({
  name: '${name}',
  description: 'Call the ${name} API',
  parameters: z.object({
    query: z.string().describe('The query to send'),
  }),
  execute: async ({ query }) => {
    const apiKey = process.env.${name.toUpperCase().replace(/-/g, '_')}_API_KEY;
    if (!apiKey) throw new Error('API key not configured');

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
  instructions: \`Use the ${name} tool when appropriate.\`,
});
`,
    tool: `import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const ${camelName}Tool = tool({
  name: '${name}',
  description: 'TODO: describe what this tool does',
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
