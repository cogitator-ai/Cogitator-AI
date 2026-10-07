import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { loadConfig } from '@cogitator-ai/config';
import { Deployer, ProjectAnalyzer } from '@cogitator-ai/deploy';
import { planProject, scaffold, writeFiles } from 'create-cogitator-app';
import { initSecrets, initSpec, type InitAnswers } from '../commands/init.js';
import { detectConfigKind } from '../utils/project-config.js';

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    projectName: 'my-assistant',
    provider: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'anthropic/claude-sonnet-5-5',
    channels: ['telegram'],
    telegramToken: '123:abc',
    memory: 'sqlite',
    ...overrides,
  };
}

function fileOf(a: InitAnswers, path: string, pm: 'pnpm' | 'npm' = 'pnpm'): string {
  const file = planProject(initSpec(a, pm)).files.find((f) => f.path === path);
  if (!file) throw new Error(`no ${path}`);
  return file.content;
}

describe('cogitator.yml of an init project', () => {
  it('is a runtime config with the provider, model, memory and deploy settings', () => {
    const doc: unknown = parse(fileOf(answers(), 'cogitator.yml'));
    expect(detectConfigKind(doc)).toBe('runtime');
    expect(doc).toEqual({
      llm: { defaultProvider: 'anthropic', defaultModel: 'anthropic/claude-sonnet-5-5' },
      memory: { adapter: 'sqlite', sqlite: { path: './data/memory.db' } },
      deploy: { kind: 'worker', secrets: ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'] },
    });
  });

  it('lists the channel secrets a deployment needs and publishes the WebChat port', () => {
    const doc: unknown = parse(
      fileOf(answers({ channels: ['discord', 'slack', 'webchat'] }), 'cogitator.yml')
    );
    expect(doc).toMatchObject({
      deploy: {
        kind: 'worker',
        port: 18789,
        secrets: [
          'ANTHROPIC_API_KEY',
          'DISCORD_BOT_TOKEN',
          'SLACK_BOT_TOKEN',
          'SLACK_SIGNING_SECRET',
        ],
      },
    });
  });

  it('points Postgres memory at DATABASE_URL and Ollama at OLLAMA_BASE_URL', () => {
    const doc: unknown = parse(
      fileOf(
        answers({ provider: 'ollama', apiKey: '', model: 'ollama/qwen3.5:9b', memory: 'postgres' }),
        'cogitator.yml'
      )
    );
    expect(doc).toMatchObject({
      llm: {
        defaultProvider: 'ollama',
        defaultModel: 'ollama/qwen3.5:9b',
        providers: { ollama: { baseUrl: '${OLLAMA_BASE_URL:-http://localhost:11434}' } },
      },
      memory: {
        adapter: 'postgres',
        postgres: {
          connectionString:
            '${DATABASE_URL:-postgresql://cogitator:cogitator@localhost:5432/cogitator}',
        },
      },
      deploy: { kind: 'worker', secrets: ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN'] },
    });
  });

  it('loads with @cogitator-ai/config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-init-yml-'));
    try {
      await writeFiles(dir, planProject(initSpec(answers(), 'pnpm')).files);
      const config = loadConfig({ configPath: join(dir, 'cogitator.yml'), skipEnv: true });
      expect(config.llm?.defaultModel).toBe('anthropic/claude-sonnet-5-5');
      expect(config.deploy?.kind).toBe('worker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deploying an init project', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-init-deploy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('needs the API key and the bot token, runs as a worker and keeps SQLite on a volume', async () => {
    await writeFiles(dir, planProject(initSpec(answers(), 'pnpm')).files);

    const result = new ProjectAnalyzer().analyze(dir, { target: 'docker' }, { env: {} });

    expect(result.deployConfig.secrets).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(result.deployConfig.kind).toBe('worker');
    expect(result.deployConfig.volumes).toEqual([{ path: 'data' }]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.installFiles).toContain('pnpm-workspace.yaml');
  });

  it('passes the project .env secrets to the deployment preflight', async () => {
    await writeFiles(
      dir,
      planProject(initSpec(answers(), 'pnpm'), { secrets: initSecrets(answers()) }).files
    );
    const deployer = new Deployer();
    deployer.registerProvider({
      name: 'check',
      preflight: async () => ({ checks: [], passed: true }),
      generate: async () => ({ files: [], outputDir: '.cogitator' }),
      deploy: async () => ({ success: true }),
      status: async () => ({ running: false }),
      destroy: async () => {},
    });

    const plan = await deployer.plan({ projectDir: dir, target: 'check' });

    expect(plan.config.secrets).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(plan.preflight.passed).toBe(true);
  });
});

describe('scaffolding an init project', () => {
  it('writes the answers as secrets to a private .env and pins the package manager', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-init-scaffold-'));
    try {
      const directory = join(root, 'my-assistant');
      await scaffold(initSpec(answers(), 'pnpm'), {
        directory,
        secrets: initSecrets(answers()),
        packageManagerSpec: 'pnpm@10.26.0',
        install: false,
        git: false,
      });

      const env = readFileSync(join(directory, '.env'), 'utf-8');
      expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test');
      expect(env).toContain('TELEGRAM_BOT_TOKEN=123:abc');
      expect(statSync(join(directory, '.env')).mode & 0o777).toBe(0o600);

      const pkg: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8'));
      expect(pkg).toMatchObject({
        packageManager: 'pnpm@10.26.0',
        dependencies: {
          '@cogitator-ai/channels': expect.stringMatching(/^\^\d/),
          grammy: expect.any(String),
        },
      });
      const gateway = readFileSync(join(directory, 'src/gateway.ts'), 'utf-8');
      expect(gateway).toContain('export const gateway = new Gateway({');
      expect(gateway).toContain('telegramChannel({ token: env.TELEGRAM_BOT_TOKEN })');
      expect(readFileSync(join(directory, 'src/index.ts'), 'utf-8')).toContain(
        "import { gateway } from './gateway.js';"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
