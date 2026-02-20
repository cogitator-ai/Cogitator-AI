import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function scaffoldProject(projectPath: string, name: string) {
  if (existsSync(projectPath)) {
    throw new Error(`Directory "${name}" already exists`);
  }

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
}

describe('CLI: Init Command Scaffolding', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-init-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('init creates project directory', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, 'src'))).toBe(true);
  });

  it('init generates valid package.json', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const pkgPath = join(projectPath, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg.name).toBe('my-project');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.type).toBe('module');
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.dev).toContain('tsx');
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/core');
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/config');
    expect(pkg.dependencies).toHaveProperty('zod');
    expect(pkg.devDependencies).toHaveProperty('typescript');
  });

  it('init generates valid tsconfig.json', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const tsconfigPath = join(projectPath, 'tsconfig.json');
    expect(existsSync(tsconfigPath)).toBe(true);

    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe('NodeNext');
    expect(tsconfig.compilerOptions.target).toBe('ES2022');
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.include).toContain('src/**/*');
  });

  it('init generates cogitator.yml', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const ymlPath = join(projectPath, 'cogitator.yml');
    expect(existsSync(ymlPath)).toBe(true);

    const content = readFileSync(ymlPath, 'utf-8');
    expect(content).toContain('defaultProvider');
    expect(content).toContain('ollama');
    expect(content).toContain('http://localhost:11434');
  });

  it('init generates agent.ts source file', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const agentPath = join(projectPath, 'src', 'agent.ts');
    expect(existsSync(agentPath)).toBe(true);

    const content = readFileSync(agentPath, 'utf-8');
    expect(content).toContain('@cogitator-ai/core');
    expect(content).toContain('Agent');
    expect(content).toContain('Cogitator');
    expect(content).toContain('tool');
  });

  it('init generates docker-compose.yml', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const composePath = join(projectPath, 'docker-compose.yml');
    expect(existsSync(composePath)).toBe(true);

    const content = readFileSync(composePath, 'utf-8');
    expect(content).toContain('redis');
    expect(content).toContain('postgres');
    expect(content).toContain('ollama');
    expect(content).toContain('6379');
    expect(content).toContain('5432');
  });

  it('init generates .gitignore', () => {
    const projectPath = join(tempDir, 'my-project');
    scaffoldProject(projectPath, 'my-project');

    const gitignorePath = join(projectPath, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('.env');
  });

  it('init errors on existing directory', () => {
    const projectPath = join(tempDir, 'existing-project');
    mkdirSync(projectPath, { recursive: true });

    expect(() => scaffoldProject(projectPath, 'existing-project')).toThrow('already exists');
  });
});
