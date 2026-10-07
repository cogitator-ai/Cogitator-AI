import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAnalyzer } from '../analyzer';
import type { ProjectBuild } from '../index';

describe('ProjectAnalyzer', () => {
  it('detects server from package.json dependencies', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({
      dependencies: { '@cogitator-ai/express': '^0.1.0' },
    });
    expect(result).toBe('express');
  });

  it('detects hono server', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({
      dependencies: { '@cogitator-ai/hono': '^0.1.0' },
    });
    expect(result).toBe('hono');
  });

  it('returns undefined when no server detected', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.detectServer({ dependencies: {} });
    expect(result).toBeUndefined();
  });

  it('detects redis service from memory config', () => {
    const analyzer = new ProjectAnalyzer();
    const services = analyzer.detectServices({ memory: { adapter: 'redis' } });
    expect(services.redis).toBe(true);
    expect(services.postgres).toBe(false);
  });

  it('detects postgres service from memory config', () => {
    const analyzer = new ProjectAnalyzer();
    const services = analyzer.detectServices({ memory: { adapter: 'postgres' } });
    expect(services.redis).toBe(false);
    expect(services.postgres).toBe(true);
  });

  it('detects required secrets from LLM provider', () => {
    const analyzer = new ProjectAnalyzer();
    const secrets = analyzer.detectSecrets('openai/gpt-4o');
    expect(secrets).toContain('OPENAI_API_KEY');
  });

  it('detects Ollama Cloud when model has :cloud tag', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.isOllamaCloud('qwen3.5:cloud');
    expect(result).toBe(true);
  });

  it('detects local Ollama for regular models', () => {
    const analyzer = new ProjectAnalyzer();
    const result = analyzer.isOllamaCloud('llama3.2:3b');
    expect(result).toBe(false);
  });

  it('warns about local Ollama in cloud deploy', () => {
    const analyzer = new ProjectAnalyzer();
    const warnings = analyzer.getDeployWarnings('ollama/llama3.2:3b', 'fly');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Ollama');
  });

  it('no Ollama warning for cloud models', () => {
    const analyzer = new ProjectAnalyzer();
    const warnings = analyzer.getDeployWarnings('ollama/qwen3.5:cloud', 'fly');
    expect(warnings.length).toBe(0);
  });
});

describe('ProjectAnalyzer.analyze', () => {
  let dir: string;
  const analyzer = new ProjectAnalyzer();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-analyze-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(file: string, content: string) {
    writeFileSync(join(dir, file), content);
  }

  it('carries detected services and secrets into the deploy config', () => {
    write('package.json', JSON.stringify({ name: '@acme/My Agent' }));
    write('cogitator.yaml', 'llm:\n  defaultModel: openai/gpt-4o\nmemory:\n  adapter: postgres\n');
    const result = analyzer.analyze(dir);
    expect(result.deployConfig.services).toEqual({ redis: false, postgres: true });
    expect(result.deployConfig.secrets).toEqual(['OPENAI_API_KEY']);
    expect(result.deployConfig.image).toBe('my-agent');
  });

  it('uses defaultProvider for unprefixed models', () => {
    write(
      'cogitator.yml',
      'llm:\n  defaultProvider: anthropic\n  defaultModel: claude-sonnet-4-6\n'
    );
    expect(analyzer.analyze(dir).secrets).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('reports invalid config files as warnings instead of silently ignoring them', () => {
    write('cogitator.yml', 'llm:\n  defaultProvider: not-a-provider\n');
    const result = analyzer.analyze(dir);
    expect(result.warnings.some((w) => w.includes('Ignoring invalid'))).toBe(true);
  });

  it('reports malformed package.json', () => {
    write('package.json', '{ nope');
    expect(analyzer.analyze(dir).warnings.some((w) => w.includes('package.json'))).toBe(true);
  });

  it('lets overrides win over detection', () => {
    write('cogitator.yml', 'llm:\n  defaultModel: openai/gpt-4o\nmemory:\n  adapter: redis\n');
    const result = analyzer.analyze(dir, {
      services: { postgres: true },
      secrets: ['CUSTOM'],
      image: 'explicit',
    });
    expect(result.deployConfig).toMatchObject({
      services: { postgres: true },
      secrets: ['CUSTOM'],
      image: 'explicit',
    });
  });

  it("honours the deploy section of the project's cogitator.yml", () => {
    write(
      'cogitator.yml',
      [
        'llm:',
        '  defaultModel: openai/gpt-4o',
        'deploy:',
        '  port: 8080',
        '  health:',
        '    path: /api/health',
        '    interval: 10s',
        '  secrets: [OPENAI_API_KEY, SEARCH_API_KEY]',
        '',
      ].join('\n')
    );

    const result = analyzer.analyze(dir);

    expect(result.deployConfig).toMatchObject({
      port: 8080,
      health: { path: '/api/health', interval: '10s' },
      secrets: ['OPENAI_API_KEY', 'SEARCH_API_KEY'],
    });
    expect(result.secrets).toEqual(['OPENAI_API_KEY', 'SEARCH_API_KEY']);
  });

  it('lets overrides win over the deploy section field by field', () => {
    write(
      'cogitator.yml',
      'deploy:\n  port: 8080\n  health:\n    path: /api/health\n    interval: 10s\n'
    );

    const result = analyzer.analyze(dir, { port: 9000, health: { interval: '1m' } });

    expect(result.deployConfig.port).toBe(9000);
    expect(result.deployConfig.health).toEqual({ path: '/api/health', interval: '1m' });
  });

  it('detects the package manager from lockfiles', () => {
    expect(analyzer.detectPackageManager(dir)).toEqual({
      packageManager: 'npm',
      hasLockfile: false,
    });
    write('package-lock.json', '{}');
    expect(analyzer.detectPackageManager(dir)).toEqual({
      packageManager: 'npm',
      hasLockfile: true,
    });
    write('yarn.lock', '');
    expect(analyzer.detectPackageManager(dir).packageManager).toBe('yarn');
    write('pnpm-lock.yaml', '');
    expect(analyzer.detectPackageManager(dir).packageManager).toBe('pnpm');
  });

  it('derives the start command from package.json', () => {
    expect(analyzer.detectStartCommand({ scripts: { start: 'node dist/index.js' } }, true)).toEqual(
      ['node', 'dist/index.js']
    );
    expect(analyzer.detectStartCommand({ scripts: { start: 'tsx src/agent.ts' } }, true)).toEqual([
      'npm',
      'start',
    ]);
    expect(analyzer.detectStartCommand({ main: 'lib/main.js' }, false)).toEqual([
      'node',
      'lib/main.js',
    ]);
    expect(analyzer.detectStartCommand({}, true)).toEqual(['node', 'dist/server.js']);
    expect(
      analyzer.detectStartCommand(
        { scripts: { start: 'node --env-file-if-exists=.env dist/index.js' } },
        true
      )
    ).toEqual(['node', 'dist/index.js']);
    expect(
      analyzer.detectStartCommand(
        { scripts: { start: 'node --enable-source-maps dist/index.js' } },
        true
      )
    ).toEqual(['node', '--enable-source-maps', 'dist/index.js']);
    expect(
      analyzer.detectStartCommand({ scripts: { start: 'bun src/index.ts' } }, true, 'bun')
    ).toEqual(['bun', 'src/index.ts']);
    expect(
      analyzer.detectStartCommand({ scripts: { start: 'node dist/index.js && echo done' } }, true)
    ).toEqual(['npm', 'start']);
    expect(analyzer.detectStartCommand({ scripts: { start: 'node $ENTRY' } }, true)).toEqual([
      'npm',
      'start',
    ]);
  });

  it('warns when instances > 1 is requested for docker', () => {
    const result = analyzer.analyze(dir, { target: 'docker', instances: 3 });
    expect(result.warnings.some((w) => w.includes('instances'))).toBe(true);
  });

  it('requires a region and both AWS secrets for bedrock and recognises -cloud Ollama tags', () => {
    expect(analyzer.detectSecrets('bedrock/claude')).toEqual([
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]);
    expect(analyzer.isOllamaCloud('ollama/gpt-oss:120b-cloud')).toBe(true);
    expect(analyzer.detectSecrets('ollama/gpt-oss:120b-cloud')).toEqual(['OLLAMA_API_KEY']);
  });

  it('describes a project build with the ProjectBuild type exported from the package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-build-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

      const build: ProjectBuild = new ProjectAnalyzer().detectBuild(dir);

      expect(build).toEqual({
        hasTypeScript: true,
        packageManager: 'pnpm',
        hasLockfile: true,
        hasBuildScript: true,
        startCommand: ['node', 'dist/server.js'],
        installFiles: ['pnpm-lock.yaml'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Yarn Plug'n'Play", () => {
  function yarnProject(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-pnp-'));
    writeFileSync(join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    return dir;
  }

  it.each([
    [
      'the default linker',
      { 'package.json': '{"packageManager":"yarn@4.9.1"}' },
      { esmLoader: false },
    ],
    [
      'an ES module project',
      { 'package.json': '{"type":"module","packageManager":"yarn@4.9.1"}' },
      { esmLoader: true },
    ],
    [
      'the ESM loader turned on',
      { 'package.json': '{}', '.yarnrc.yml': 'nodeLinker: pnp\npnpEnableEsmLoader: true\n' },
      { esmLoader: true },
    ],
    [
      'node_modules',
      { 'package.json': '{}', '.yarnrc.yml': 'nodeLinker: node-modules\n' },
      undefined,
    ],
  ])('reads %s', (_, files, expected) => {
    const dir = yarnProject(files);
    try {
      expect(new ProjectAnalyzer().detectBuild(dir).plugAndPlay).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves other package managers alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-pnp-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      expect(new ProjectAnalyzer().detectBuild(dir).plugAndPlay).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('local dependencies', () => {
  it('copies vendored packages and local links before the install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-local-deps-'));
    try {
      mkdirSync(join(dir, 'vendor'));
      mkdirSync(join(dir, 'libs'));
      writeFileSync(join(dir, 'vendor', 'tool.tgz'), '');
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      writeFileSync(
        join(dir, 'pnpm-workspace.yaml'),
        "overrides:\n  '@acme/core': 'file:vendor/core.tgz'\n"
      );
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          dependencies: { tool: 'file:vendor/tool.tgz', shared: 'link:libs/shared', zod: '^4.0.0' },
          devDependencies: { outside: 'file:../elsewhere' },
        })
      );

      const build = new ProjectAnalyzer().detectBuild(dir);
      expect(build.installFiles).toEqual(
        expect.arrayContaining(['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vendor/', 'libs/'])
      );
      expect(build.installFiles.some((file) => file.includes('..'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
