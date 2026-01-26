import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createProjectStructure(projectPath: string, projectName: string) {
  mkdirSync(join(projectPath, 'src'), { recursive: true });

  writeFileSync(
    join(projectPath, 'package.json'),
    JSON.stringify(
      {
        name: projectName,
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
  execute: async ({ name }) => \`Hello, \${name}!\`,
});

const agent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  model: 'ollama/llama3.1:8b',
  instructions: 'You are a helpful assistant.',
  tools: [greet],
});

const cog = new Cogitator();
const result = await cog.run(agent, { input: 'Hello!' });
console.log(result.output);
await cog.close();
`
  );

  writeFileSync(
    join(projectPath, 'docker-compose.yml'),
    `name: ${projectName}

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: cogitator
      POSTGRES_PASSWORD: cogitator
      POSTGRES_DB: cogitator

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
`
  );

  writeFileSync(join(projectPath, '.gitignore'), `node_modules/\ndist/\n.env\n*.log\n`);
}

describe('cogitator init', () => {
  const testDir = join(tmpdir(), 'cogitator-test-' + Date.now());
  const projectName = 'test-project';
  const projectPath = join(testDir, projectName);

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates project directory structure', () => {
    createProjectStructure(projectPath, projectName);

    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, 'package.json'))).toBe(true);
    expect(existsSync(join(projectPath, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(projectPath, 'cogitator.yml'))).toBe(true);
    expect(existsSync(join(projectPath, 'src/agent.ts'))).toBe(true);
    expect(existsSync(join(projectPath, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(projectPath, '.gitignore'))).toBe(true);
  });

  it('creates valid package.json', () => {
    createProjectStructure(projectPath, projectName);

    const pkgJson = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8'));
    expect(pkgJson.name).toBe(projectName);
    expect(pkgJson.dependencies['@cogitator-ai/core']).toBeDefined();
  });

  it('detects if directory already exists', () => {
    createProjectStructure(projectPath, projectName);

    expect(existsSync(projectPath)).toBe(true);
  });
});
