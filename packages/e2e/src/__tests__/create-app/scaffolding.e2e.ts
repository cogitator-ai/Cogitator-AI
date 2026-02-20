import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type Template = 'basic' | 'memory' | 'swarm' | 'workflow' | 'api-server' | 'nextjs';
type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'google';
type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

interface ParsedArgs {
  name?: string;
  template?: Template;
  provider?: LLMProvider;
  packageManager?: PackageManager;
  docker?: boolean;
  git?: boolean;
  yes?: boolean;
}

interface ProjectOptions {
  name: string;
  path: string;
  template: Template;
  provider: LLMProvider;
  packageManager: PackageManager;
  docker: boolean;
  git: boolean;
}

const validTemplates: Template[] = ['basic', 'memory', 'swarm', 'workflow', 'api-server', 'nextjs'];
const validProviders: LLMProvider[] = ['ollama', 'openai', 'anthropic', 'google'];
const validPMs: PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun'];

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--template' || arg === '-t') {
      const val = args[++i] as Template;
      if (validTemplates.includes(val)) parsed.template = val;
    } else if (arg === '--provider' || arg === '-p') {
      const val = args[++i] as LLMProvider;
      if (validProviders.includes(val)) parsed.provider = val;
    } else if (arg === '--pm') {
      const val = args[++i] as PackageManager;
      if (validPMs.includes(val)) parsed.packageManager = val;
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

vi.mock('@clack/prompts', () => ({
  spinner: () => ({
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

async function runScaffold(options: ProjectOptions): Promise<void> {
  const scaffoldModule = await import(
    resolve(process.cwd(), '../create-cogitator-app/src/scaffold.ts')
  );
  await scaffoldModule.scaffold(options);
}

function createOptions(overrides: Partial<ProjectOptions> = {}): ProjectOptions {
  const tempDir = mkdtempSync(join(tmpdir(), 'cca-test-'));
  const projectPath = join(tempDir, 'test-project');
  return {
    name: 'test-project',
    path: projectPath,
    template: 'basic',
    provider: 'ollama',
    packageManager: 'pnpm',
    docker: true,
    git: false,
    ...overrides,
  };
}

describe('create-cogitator-app: Argument Parsing', () => {
  it('parseArgs parses project name', () => {
    const result = parseArgs(['my-app']);
    expect(result.name).toBe('my-app');
  });

  it('parseArgs parses --template flag', () => {
    const result = parseArgs(['--template', 'swarm']);
    expect(result.template).toBe('swarm');
  });

  it('parseArgs parses -t short flag', () => {
    const result = parseArgs(['-t', 'workflow']);
    expect(result.template).toBe('workflow');
  });

  it('parseArgs parses --provider flag', () => {
    const result = parseArgs(['--provider', 'openai']);
    expect(result.provider).toBe('openai');
  });

  it('parseArgs parses --pm flag', () => {
    const result = parseArgs(['--pm', 'bun']);
    expect(result.packageManager).toBe('bun');
  });

  it('parseArgs handles --no-docker', () => {
    const result = parseArgs(['--no-docker']);
    expect(result.docker).toBe(false);
  });

  it('parseArgs handles --no-git', () => {
    const result = parseArgs(['--no-git']);
    expect(result.git).toBe(false);
  });

  it('parseArgs ignores invalid template values', () => {
    const result = parseArgs(['--template', 'invalid-template']);
    expect(result.template).toBeUndefined();
  });

  it('parseArgs combines multiple flags', () => {
    const result = parseArgs([
      'my-app',
      '-t',
      'memory',
      '-p',
      'anthropic',
      '--pm',
      'yarn',
      '--no-docker',
      '--no-git',
    ]);
    expect(result.name).toBe('my-app');
    expect(result.template).toBe('memory');
    expect(result.provider).toBe('anthropic');
    expect(result.packageManager).toBe('yarn');
    expect(result.docker).toBe(false);
    expect(result.git).toBe(false);
  });
});

describe('create-cogitator-app: Scaffold Templates', () => {
  let options: ProjectOptions;

  afterEach(() => {
    if (options?.path) {
      rmSync(options.path, { recursive: true, force: true });
      const parent = resolve(options.path, '..');
      if (existsSync(parent)) rmSync(parent, { recursive: true, force: true });
    }
  });

  it('scaffold generates basic template files', async () => {
    options = createOptions({ template: 'basic' });
    await runScaffold(options);

    expect(existsSync(join(options.path, 'package.json'))).toBe(true);
    expect(existsSync(join(options.path, 'cogitator.yml'))).toBe(true);
    expect(existsSync(join(options.path, '.gitignore'))).toBe(true);
    expect(existsSync(join(options.path, '.env.example'))).toBe(true);
    expect(existsSync(join(options.path, 'README.md'))).toBe(true);
    expect(existsSync(join(options.path, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(options.path, 'src', 'index.ts'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('test-project');
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/core');
  });

  it('scaffold generates memory template files', async () => {
    options = createOptions({ template: 'memory' });
    await runScaffold(options);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/memory');
  });

  it('scaffold generates swarm template files', async () => {
    options = createOptions({ template: 'swarm' });
    await runScaffold(options);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/swarms');
    expect(existsSync(join(options.path, 'src', 'index.ts'))).toBe(true);
  });

  it('scaffold generates workflow template files', async () => {
    options = createOptions({ template: 'workflow' });
    await runScaffold(options);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/workflows');
  });

  it('scaffold generates api-server template files', async () => {
    options = createOptions({ template: 'api-server' });
    await runScaffold(options);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('@cogitator-ai/express');
    expect(pkg.dependencies).toHaveProperty('express');
  });

  it('scaffold generates nextjs template files', async () => {
    options = createOptions({ template: 'nextjs' });
    await runScaffold(options);

    const pkg = JSON.parse(readFileSync(join(options.path, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('next');
    expect(pkg.dependencies).toHaveProperty('react');

    expect(existsSync(join(options.path, 'next.config.ts'))).toBe(true);
  });

  it('scaffold includes docker-compose when docker=true', async () => {
    options = createOptions({ docker: true });
    await runScaffold(options);

    expect(existsSync(join(options.path, 'docker-compose.yml'))).toBe(true);
    const compose = readFileSync(join(options.path, 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('redis');
    expect(compose).toContain('postgres');
  });

  it('scaffold excludes docker-compose when docker=false', async () => {
    options = createOptions({ docker: false });
    await runScaffold(options);

    expect(existsSync(join(options.path, 'docker-compose.yml'))).toBe(false);
  });
});
