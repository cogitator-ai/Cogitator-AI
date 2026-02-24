import { describe, it, expect, afterEach } from 'vitest';
import { scaffold } from 'create-cogitator-app';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectOptions } from 'create-cogitator-app';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cogitator-e2e-'));
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const baseOptions: Omit<ProjectOptions, 'path' | 'name'> = {
  template: 'basic',
  provider: 'ollama',
  packageManager: 'pnpm',
  docker: false,
  git: false,
};

describe('scaffold e2e', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      cleanup(dir);
    }
    dirs.length = 0;
  });

  function makeOptions(overrides: Partial<ProjectOptions> = {}): ProjectOptions {
    const tmpDir = makeTempDir();
    dirs.push(tmpDir);
    const projectDir = path.join(tmpDir, 'my-project');
    return {
      name: 'my-project',
      path: projectDir,
      ...baseOptions,
      ...overrides,
    };
  }

  it('creates project directory and files for basic template', async () => {
    const opts = makeOptions();
    await scaffold(opts);

    expect(fs.existsSync(opts.path)).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'src/index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'src/tools.ts'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, '.env.example'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'cogitator.yml'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'tsconfig.json'))).toBe(true);
  });

  it('generates valid package.json with correct name', async () => {
    const opts = makeOptions({ name: 'test-agent' });
    await scaffold(opts);

    const pkgJson = JSON.parse(fs.readFileSync(path.join(opts.path, 'package.json'), 'utf-8'));

    expect(pkgJson.name).toBe('test-agent');
    expect(pkgJson.version).toBe('0.1.0');
    expect(pkgJson.dependencies).toHaveProperty('@cogitator-ai/core');
    expect(pkgJson.devDependencies).toHaveProperty('typescript');
    expect(pkgJson.devDependencies).toHaveProperty('tsx');
    expect(pkgJson.scripts).toHaveProperty('dev');
    expect(pkgJson.scripts).toHaveProperty('start');
  });

  it('generates docker-compose.yml when docker is true', async () => {
    const opts = makeOptions({ docker: true });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, 'docker-compose.yml'))).toBe(true);
    const content = fs.readFileSync(path.join(opts.path, 'docker-compose.yml'), 'utf-8');
    expect(content).toContain('redis:');
    expect(content).toContain('postgres:');
  });

  it('does not generate docker-compose.yml when docker is false', async () => {
    const opts = makeOptions({ docker: false });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, 'docker-compose.yml'))).toBe(false);
  });

  it('generates correct files for memory template', async () => {
    const opts = makeOptions({ template: 'memory' });
    await scaffold(opts);

    const pkgJson = JSON.parse(fs.readFileSync(path.join(opts.path, 'package.json'), 'utf-8'));
    expect(pkgJson.dependencies).toHaveProperty('@cogitator-ai/memory');
    expect(pkgJson.dependencies).toHaveProperty('@cogitator-ai/redis');

    const envExample = fs.readFileSync(path.join(opts.path, '.env.example'), 'utf-8');
    expect(envExample).toContain('REDIS_URL');
  });

  it('generates correct files for workflow template', async () => {
    const opts = makeOptions({ template: 'workflow' });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, 'src/agents.ts'))).toBe(true);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(opts.path, 'package.json'), 'utf-8'));
    expect(pkgJson.dependencies).toHaveProperty('@cogitator-ai/workflows');
  });

  it('generates correct files for swarm template', async () => {
    const opts = makeOptions({ template: 'swarm' });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, 'src/agents/researcher.ts'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'src/agents/writer.ts'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, 'src/agents/reviewer.ts'))).toBe(true);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(opts.path, 'package.json'), 'utf-8'));
    expect(pkgJson.dependencies).toHaveProperty('@cogitator-ai/swarms');
  });

  it('throws when target directory is non-empty', async () => {
    const tmpDir = makeTempDir();
    dirs.push(tmpDir);
    const projectDir = path.join(tmpDir, 'existing');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'existing.txt'), 'existing content');

    const opts: ProjectOptions = {
      name: 'existing',
      path: projectDir,
      ...baseOptions,
    };

    await expect(scaffold(opts)).rejects.toThrow('already exists and is not empty');
  });

  it('generates cogitator.yml with correct provider', async () => {
    const opts = makeOptions({ provider: 'openai' });
    await scaffold(opts);

    const yml = fs.readFileSync(path.join(opts.path, 'cogitator.yml'), 'utf-8');
    expect(yml).toContain('openai');
  });

  it('initializes git repository when git is true', async () => {
    const opts = makeOptions({ git: true });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(opts.path, '.git', 'HEAD'))).toBe(true);
  });

  it('does not create .git when git is false', async () => {
    const opts = makeOptions({ git: false });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, '.git'))).toBe(false);
  });

  it('generates next-specific tsconfig.json for nextjs template', async () => {
    const opts = makeOptions({ template: 'nextjs' });
    await scaffold(opts);

    expect(fs.existsSync(path.join(opts.path, 'tsconfig.json'))).toBe(true);
    const tsconfig = JSON.parse(fs.readFileSync(path.join(opts.path, 'tsconfig.json'), 'utf-8'));
    expect(tsconfig.compilerOptions.jsx).toBeDefined();
  });
});
