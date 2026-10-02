import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEnvFile,
  buildGatewayFile,
  buildPackageJson,
  buildProjectFiles,
  detectPackageManager,
  resolveDependencyVersions,
  validateProjectName,
  writeProjectFiles,
  type InitAnswers,
} from '../commands/init.js';

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
    model: 'anthropic/claude-sonnet-4-6',
    channels: ['webchat'],
    memory: 'sqlite',
    ...overrides,
  };
}

describe('validateProjectName', () => {
  it('accepts npm-style names', () => {
    expect(validateProjectName('my-assistant')).toBeUndefined();
    expect(validateProjectName('bot_2.0')).toBeUndefined();
  });

  it('rejects empty, uppercase and path-like names', () => {
    expect(validateProjectName('  ')).toBe('Name is required');
    expect(validateProjectName('MyBot')).toBeDefined();
    expect(validateProjectName('../evil')).toBeDefined();
    expect(validateProjectName('a/b')).toBeDefined();
    expect(validateProjectName('.hidden')).toBeDefined();
  });
});

describe('resolveDependencyVersions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-init-deps-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the published versions of the CLI dependencies', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(
      pkg,
      JSON.stringify({
        dependencies: {
          '@cogitator-ai/core': '0.19.4',
          '@cogitator-ai/channels': '^0.2.5',
          '@cogitator-ai/memory': '~0.6.22',
        },
      })
    );
    expect(resolveDependencyVersions(pkg)).toEqual(VERSIONS);
  });

  it('falls back to "latest" for workspace protocol ranges', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ dependencies: { '@cogitator-ai/core': 'workspace:*' } }));
    const versions = resolveDependencyVersions(pkg);
    expect(versions['@cogitator-ai/core']).toBe('latest');
    expect(versions['@cogitator-ai/memory']).toBe('latest');
  });

  it('never produces the stale ^0.1.0 range', () => {
    const versions = resolveDependencyVersions();
    expect(Object.values(versions)).not.toContain('^0.1.0');
  });
});

describe('detectPackageManager', () => {
  it('reads npm_config_user_agent', () => {
    expect(detectPackageManager('npm/10.8.0 node/v22.0.0 darwin arm64')).toBe('npm');
    expect(detectPackageManager('yarn/1.22.0 npm/? node/v22.0.0')).toBe('yarn');
    expect(detectPackageManager('bun/1.1.0')).toBe('bun');
  });

  it('defaults to pnpm', () => {
    expect(detectPackageManager(undefined)).toBe('pnpm');
    expect(detectPackageManager('unknown/1.0')).toBe('pnpm');
  });
});

describe('buildPackageJson', () => {
  it('pins Cogitator packages and adds channel/memory dependencies', () => {
    const pkg = JSON.parse(
      buildPackageJson(answers({ channels: ['telegram', 'webchat'], memory: 'postgres' }), {
        dependencyVersions: VERSIONS,
      })
    );
    expect(pkg.name).toBe('my-assistant');
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies['@cogitator-ai/core']).toBe('^0.19.4');
    expect(pkg.dependencies.grammy).toBeDefined();
    expect(pkg.dependencies.ws).toBeDefined();
    expect(pkg.dependencies.pg).toBeDefined();
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.scripts.dev).toContain('src/agent.ts');
  });

  it('adds better-sqlite3 for the sqlite adapter', () => {
    const pkg = JSON.parse(
      buildPackageJson(answers({ memory: 'sqlite' }), { dependencyVersions: VERSIONS })
    );
    expect(pkg.dependencies['better-sqlite3']).toBeDefined();
  });
});

describe('buildEnvFile', () => {
  it('writes provider key and channel secrets, quoting when needed', () => {
    const env = buildEnvFile(
      answers({
        channels: ['slack'],
        slackToken: 'xoxb-1',
        slackSigningSecret: 'has space',
      })
    );
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test');
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-1');
    expect(env).toContain('SLACK_SIGNING_SECRET="has space"');
  });

  it('adds DATABASE_URL for postgres', () => {
    const env = buildEnvFile(
      answers({
        provider: 'ollama',
        apiKey: '',
        memory: 'postgres',
        databaseUrl: 'postgres://u@h/db',
      })
    );
    expect(env).toBe('DATABASE_URL=postgres://u@h/db\n');
  });

  it('returns null when there is nothing to write', () => {
    expect(buildEnvFile(answers({ provider: 'ollama', apiKey: '', memory: 'memory' }))).toBeNull();
  });
});

describe('buildGatewayFile', () => {
  it('uses the selected memory adapter and connects it', () => {
    const sqlite = buildGatewayFile(answers({ memory: 'sqlite' }));
    expect(sqlite).toContain("import { SQLiteAdapter } from '@cogitator-ai/memory'");
    expect(sqlite).toContain('await memory.connect()');

    const postgres = buildGatewayFile(answers({ memory: 'postgres' }));
    expect(postgres).toContain('PostgresAdapter');
    expect(postgres).toContain("requireEnv('DATABASE_URL')");

    const inMemory = buildGatewayFile(answers({ memory: 'memory' }));
    expect(inMemory).toContain("new InMemoryAdapter({ provider: 'memory' })");
  });

  it('loads .env relative to the module and sets the default provider', () => {
    const content = buildGatewayFile(answers());
    expect(content).toContain("new URL('../.env', import.meta.url)");
    expect(content).toContain("defaultProvider: 'anthropic'");
    expect(content).toContain("anthropic: { apiKey: requireEnv('ANTHROPIC_API_KEY') }");
  });

  it('wires every selected channel', () => {
    const content = buildGatewayFile(
      answers({ channels: ['telegram', 'discord', 'slack', 'webchat'] })
    );
    for (const factory of ['telegramChannel', 'discordChannel', 'slackChannel', 'webchatChannel']) {
      expect(content).toContain(`${factory}(`);
    }
  });

  it('uses OLLAMA_URL for ollama projects', () => {
    const content = buildGatewayFile(
      answers({ provider: 'ollama', apiKey: '', model: 'ollama/llama3.1:8b' })
    );
    expect(content).toContain(
      "ollama: { baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434' }"
    );
  });
});

describe('writeProjectFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-init-write-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the full project and keeps .env private', () => {
    const files = buildProjectFiles(answers(), { dependencyVersions: VERSIONS });
    writeProjectFiles(dir, files);

    for (const file of [
      'package.json',
      'tsconfig.json',
      'src/gateway.ts',
      'src/agent.ts',
      '.gitignore',
      '.env',
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('data/');
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    }
  });
});
