import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { loadConfig } from '@cogitator-ai/config';
import { Deployer, ProjectAnalyzer } from '@cogitator-ai/deploy';
import {
  buildCogitatorYml,
  buildProjectFiles,
  detectPackageManagerSpec,
  writeProjectFiles,
  type InitAnswers,
} from '../commands/init.js';
import { detectConfigKind } from '../utils/project-config.js';

const VERSIONS = {
  '@cogitator-ai/core': '^0.19.4',
  '@cogitator-ai/channels': '^0.2.5',
  '@cogitator-ai/memory': '^0.6.22',
};

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    projectName: 'my-assistant',
    provider: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5-5',
    channels: ['telegram'],
    telegramToken: '123:abc',
    memory: 'sqlite',
    ...overrides,
  };
}

describe('cogitator.yml of an init project', () => {
  it('is a runtime config with the provider, model, memory and deploy settings', () => {
    const doc: unknown = parse(buildCogitatorYml(answers()));
    expect(detectConfigKind(doc)).toBe('runtime');
    expect(doc).toEqual({
      llm: { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5-5' },
      memory: { adapter: 'sqlite', sqlite: { path: './data/memory.db' } },
      deploy: { kind: 'worker', secrets: ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'] },
    });
  });

  it('lists every channel secret and publishes the WebChat port', () => {
    const doc: unknown = parse(
      buildCogitatorYml(
        answers({
          channels: ['discord', 'slack', 'webchat'],
          discordToken: 'd',
          slackToken: 'xoxb',
          slackSigningSecret: 's',
          slackAppToken: 'xapp',
        })
      )
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
          'SLACK_APP_TOKEN',
        ],
      },
    });
  });

  it('points Postgres memory at DATABASE_URL and Ollama at OLLAMA_URL', () => {
    const doc: unknown = parse(
      buildCogitatorYml(
        answers({ provider: 'ollama', apiKey: '', model: 'qwen3.5:9b', memory: 'postgres' })
      )
    );
    expect(doc).toMatchObject({
      llm: {
        defaultProvider: 'ollama',
        providers: { ollama: { baseUrl: '${OLLAMA_URL:-http://localhost:11434}' } },
      },
      memory: { adapter: 'postgres', postgres: { connectionString: '${DATABASE_URL}' } },
      deploy: { kind: 'worker', secrets: ['TELEGRAM_BOT_TOKEN'] },
    });
  });

  it('loads with @cogitator-ai/config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-init-yml-'));
    try {
      writeProjectFiles(dir, buildProjectFiles(answers(), { dependencyVersions: VERSIONS }));
      const config = loadConfig({ configPath: join(dir, 'cogitator.yml'), skipEnv: true });
      expect(config.llm?.defaultModel).toBe('claude-sonnet-5-5');
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

  it('needs the API key and the bot token, runs as a worker and keeps SQLite on a volume', () => {
    writeProjectFiles(
      dir,
      buildProjectFiles(answers(), { dependencyVersions: VERSIONS, packageManager: 'pnpm' })
    );

    const result = new ProjectAnalyzer().analyze(dir, { target: 'docker' }, { env: {} });

    expect(result.deployConfig.secrets).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    expect(result.deployConfig.kind).toBe('worker');
    expect(result.deployConfig.volumes).toEqual([{ path: 'data' }]);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.installFiles).toContain('pnpm-workspace.yaml');
  });

  it('passes the project .env secrets to the deployment preflight', async () => {
    writeProjectFiles(dir, buildProjectFiles(answers(), { dependencyVersions: VERSIONS }));
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

describe('SQLite memory of an init project', () => {
  it('creates the data directory before opening the database', () => {
    const gateway = buildProjectFiles(answers(), { dependencyVersions: VERSIONS })[
      'src/gateway.ts'
    ];
    const mkdir = gateway.indexOf("mkdirSync('./data', { recursive: true });");
    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(gateway.indexOf('new SQLiteAdapter'));
    expect(gateway).toContain("import { existsSync, mkdirSync } from 'node:fs';");

    const postgres = buildProjectFiles(answers({ memory: 'postgres' }), {
      dependencyVersions: VERSIONS,
    })['src/gateway.ts'];
    expect(postgres).not.toContain('mkdirSync');
  });
});

describe('packageManager field', () => {
  it('pins the package manager and version that ran the scaffolder', () => {
    expect(detectPackageManagerSpec('pnpm/10.26.0 npm/? node/v22.23.1 darwin arm64')).toBe(
      'pnpm@10.26.0'
    );
    expect(detectPackageManagerSpec('yarn/4.5.0 npm/? node/v22.23.1')).toBe('yarn@4.5.0');
    expect(detectPackageManagerSpec('npm/10.9.0 node/v22.23.1')).toBeUndefined();
    expect(detectPackageManagerSpec('')).toBeUndefined();
  });

  it('is written to package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-init-pm-'));
    try {
      writeProjectFiles(
        dir,
        buildProjectFiles(answers(), {
          dependencyVersions: VERSIONS,
          packageManager: 'pnpm',
          packageManagerSpec: 'pnpm@10.26.0',
        })
      );
      const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      expect(pkg).toMatchObject({ packageManager: 'pnpm@10.26.0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
