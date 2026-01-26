/**
 * cogitator init <name> - scaffold new project
 */

import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import ora from 'ora';
import chalk from 'chalk';
import { log, printBanner } from '../utils/logger.js';

export const initCommand = new Command('init')
  .description('Create a new Cogitator project')
  .argument('<name>', 'Project name')
  .option('--no-install', 'Skip dependency installation')
  .action(async (name: string, options: { install: boolean }) => {
    printBanner();

    const projectPath = resolve(process.cwd(), name);

    if (existsSync(projectPath)) {
      log.error(`Directory "${name}" already exists`);
      process.exit(1);
    }

    log.info(`Creating project: ${chalk.bold(name)}`);

    const spinner = ora('Setting up project structure...').start();

    try {
      mkdirSync(join(projectPath, 'src'), { recursive: true });

      writeFileSync(
        join(projectPath, 'package.json'),
        JSON.stringify(
          {
            name,
            version: '0.1.0',
            type: 'module',
            scripts: {
              dev: 'tsx watch src/agent.ts',
              start: 'tsx src/agent.ts',
              build: 'tsc',
            },
            dependencies: {
              '@cogitator-ai/core': '^0.1.0',
              '@cogitator-ai/config': '^0.1.0',
              zod: '^3.22.4',
            },
            devDependencies: {
              '@types/node': '^20.10.0',
              tsx: '^4.7.0',
              typescript: '^5.3.0',
            },
          },
          null,
          2
        )
      );

      writeFileSync(
        join(projectPath, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              outDir: './dist',
              rootDir: './src',
            },
            include: ['src/**/*'],
          },
          null,
          2
        )
      );

      writeFileSync(
        join(projectPath, 'cogitator.yml'),
        `# Cogitator Configuration
llm:
  defaultProvider: ollama
  providers:
    ollama:
      baseUrl: http://localhost:11434

memory:
  adapter: memory
`
      );

      writeFileSync(
        join(projectPath, 'src', 'agent.ts'),
        `import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const greet = tool({
  name: 'greet',
  description: 'Greet someone by name',
  parameters: z.object({
    name: z.string().describe('Name to greet'),
  }),
  execute: async ({ name }) => \`Hello, \${name}! 👋\`,
});

const agent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  model: 'ollama/llama3.1:8b',
  instructions: 'You are a helpful assistant. Use the greet tool when asked to greet someone.',
  tools: [greet],
});

const cog = new Cogitator();

const result = await cog.run(agent, {
  input: 'Hello! Can you greet Alex?',
});

console.log('Agent:', result.output);

await cog.close();
`
      );

      writeFileSync(
        join(projectPath, 'docker-compose.yml'),
        `name: ${name}

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: cogitator
      POSTGRES_PASSWORD: cogitator
      POSTGRES_DB: cogitator
    volumes:
      - postgres-data:/var/lib/postgresql/data

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama

volumes:
  redis-data:
  postgres-data:
  ollama-data:
`
      );

      writeFileSync(
        join(projectPath, '.gitignore'),
        `node_modules/
dist/
.env
*.log
`
      );

      spinner.succeed('Project structure created');

      if (options.install) {
        const installSpinner = ora('Installing dependencies...').start();
        try {
          execSync('pnpm install', { cwd: projectPath, stdio: 'pipe' });
          installSpinner.succeed('Dependencies installed');
        } catch {
          installSpinner.warn('Could not install dependencies. Run pnpm install manually.');
        }
      }

      console.log();
      log.success(`Project "${name}" created successfully!`);
      console.log();
      log.dim('Next steps:');
      console.log();
      console.log(`  cd ${name}`);
      if (!options.install) {
        console.log('  pnpm install');
      }
      console.log('  cogitator up          # Start Docker services');
      console.log('  pnpm dev              # Run your agent');
      console.log();
    } catch (error) {
      spinner.fail('Failed to create project');
      log.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
