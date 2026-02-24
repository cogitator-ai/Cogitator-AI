import { describe, it, expect, afterEach } from 'vitest';
import { detectPackageManager, devCommand, runCommand } from '../utils/package-manager.js';
import { providerEnvKey, providerConfig } from '../utils/providers.js';
import { generateEnvExample } from '../templates/base/env-example.js';
import { generateDockerCompose } from '../templates/base/docker-compose.js';
import { generateGitignore } from '../templates/base/gitignore.js';
import { generateTsconfig } from '../templates/base/tsconfig.js';
import { generateCogitatorYml } from '../templates/base/cogitator-yml.js';
import { generateReadme } from '../templates/base/readme.js';
import type { ProjectOptions } from '../types.js';

describe('detectPackageManager', () => {
  const originalEnv = process.env.npm_config_user_agent;

  afterEach(() => {
    process.env.npm_config_user_agent = originalEnv;
  });

  it('detects pnpm', () => {
    process.env.npm_config_user_agent = 'pnpm/8.0.0 npm/? node/v22.0.0';
    expect(detectPackageManager()).toBe('pnpm');
  });

  it('detects yarn', () => {
    process.env.npm_config_user_agent = 'yarn/1.22.0 npm/? node/v22.0.0';
    expect(detectPackageManager()).toBe('yarn');
  });

  it('detects bun', () => {
    process.env.npm_config_user_agent = 'bun/1.0.0';
    expect(detectPackageManager()).toBe('bun');
  });

  it('defaults to pnpm when no user agent', () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager()).toBe('pnpm');
  });
});

describe('devCommand', () => {
  it('returns npm run dev for npm', () => {
    expect(devCommand('npm')).toBe('npm run dev');
  });

  it('returns pnpm dev for pnpm', () => {
    expect(devCommand('pnpm')).toBe('pnpm dev');
  });

  it('returns yarn dev for yarn', () => {
    expect(devCommand('yarn')).toBe('yarn dev');
  });

  it('returns bun dev for bun', () => {
    expect(devCommand('bun')).toBe('bun dev');
  });
});

describe('runCommand', () => {
  it('returns npx for npm', () => {
    expect(runCommand('npm')).toBe('npx');
  });

  it('returns pnpm dlx for pnpm', () => {
    expect(runCommand('pnpm')).toBe('pnpm dlx');
  });

  it('returns yarn dlx for yarn', () => {
    expect(runCommand('yarn')).toBe('yarn dlx');
  });

  it('returns bunx for bun', () => {
    expect(runCommand('bun')).toBe('bunx');
  });
});

describe('generateEnvExample', () => {
  it('includes Ollama comment for ollama provider', () => {
    const file = generateEnvExample('ollama');
    expect(file.path).toBe('.env.example');
    expect(file.content).toContain('OLLAMA_BASE_URL');
  });

  it('includes OPENAI_API_KEY for openai provider', () => {
    const file = generateEnvExample('openai');
    expect(file.content).toContain('OPENAI_API_KEY=sk-...');
  });

  it('includes ANTHROPIC_API_KEY for anthropic provider', () => {
    const file = generateEnvExample('anthropic');
    expect(file.content).toContain('ANTHROPIC_API_KEY=sk-ant-...');
  });

  it('includes GOOGLE_API_KEY for google provider', () => {
    const file = generateEnvExample('google');
    expect(file.content).toContain('GOOGLE_API_KEY=');
  });

  it('includes REDIS_URL for memory template', () => {
    const file = generateEnvExample('openai', 'memory');
    expect(file.content).toContain('REDIS_URL=redis://localhost:6379');
  });

  it('does not include REDIS_URL for non-memory templates', () => {
    const file = generateEnvExample('openai', 'basic');
    expect(file.content).not.toContain('REDIS_URL');
  });

  it('does not include REDIS_URL when no template specified', () => {
    const file = generateEnvExample('openai');
    expect(file.content).not.toContain('REDIS_URL');
  });
});

describe('generateDockerCompose', () => {
  it('includes redis and postgres services', () => {
    const file = generateDockerCompose('openai');
    expect(file.path).toBe('docker-compose.yml');
    expect(file.content).toContain('redis:');
    expect(file.content).toContain('postgres:');
  });

  it('includes ollama service for ollama provider', () => {
    const file = generateDockerCompose('ollama');
    expect(file.content).toContain('ollama:');
    expect(file.content).toContain('ollama/ollama:latest');
    expect(file.content).toContain('ollama_data:');
  });

  it('does not include ollama service for other providers', () => {
    const file = generateDockerCompose('openai');
    expect(file.content).not.toContain('ollama:');
  });

  it('uses env var defaults for postgres credentials', () => {
    const file = generateDockerCompose('openai');
    expect(file.content).toContain('${POSTGRES_USER:-cogitator}');
    expect(file.content).toContain('${POSTGRES_PASSWORD:-cogitator}');
    expect(file.content).toContain('${POSTGRES_DB:-cogitator}');
  });

  it('includes volume definitions', () => {
    const file = generateDockerCompose('openai');
    expect(file.content).toContain('volumes:');
    expect(file.content).toContain('redis_data:');
    expect(file.content).toContain('postgres_data:');
  });
});

describe('generateGitignore', () => {
  it('includes node_modules', () => {
    const file = generateGitignore();
    expect(file.path).toBe('.gitignore');
    expect(file.content).toContain('node_modules');
  });

  it('includes .env', () => {
    const file = generateGitignore();
    expect(file.content).toContain('.env');
  });

  it('includes dist', () => {
    const file = generateGitignore();
    expect(file.content).toContain('dist');
  });
});

describe('generateTsconfig', () => {
  it('returns a valid tsconfig.json path', () => {
    const file = generateTsconfig();
    expect(file.path).toBe('tsconfig.json');
  });

  it('includes module es2022 or esnext', () => {
    const file = generateTsconfig();
    expect(file.content).toMatch(/es2022|esnext/i);
  });

  it('is valid JSON', () => {
    const file = generateTsconfig();
    expect(() => JSON.parse(file.content)).not.toThrow();
  });
});

describe('generateCogitatorYml', () => {
  it('generates cogitator.yml path', () => {
    const file = generateCogitatorYml('openai');
    expect(file.path).toBe('cogitator.yml');
  });

  it('includes provider name', () => {
    const file = generateCogitatorYml('openai');
    expect(file.content).toContain('provider: openai');
  });

  it('includes model name', () => {
    const file = generateCogitatorYml('openai');
    expect(file.content).toContain('model: gpt-4o');
  });

  it('includes ollama baseUrl for ollama provider', () => {
    const file = generateCogitatorYml('ollama');
    expect(file.content).toContain('baseUrl: http://localhost:11434');
  });

  it('does not include ollama section for other providers', () => {
    const file = generateCogitatorYml('openai');
    expect(file.content).not.toContain('baseUrl:');
  });

  it('uses gemini-2.5-flash for google provider', () => {
    const file = generateCogitatorYml('google');
    expect(file.content).toContain('gemini-2.5-flash');
    expect(file.content).not.toContain('gemini-2.0');
  });
});

describe('generateReadme', () => {
  const baseOpts: ProjectOptions = {
    name: 'my-agent',
    path: '/tmp/my-agent',
    template: 'basic',
    provider: 'ollama',
    packageManager: 'pnpm',
    docker: false,
    git: false,
  };

  it('generates README.md path', () => {
    const file = generateReadme(baseOpts);
    expect(file.path).toBe('README.md');
  });

  it('includes project name as heading', () => {
    const file = generateReadme(baseOpts);
    expect(file.content).toContain('# my-agent');
  });

  it('includes dev command for package manager', () => {
    const file = generateReadme({ ...baseOpts, packageManager: 'npm' });
    expect(file.content).toContain('npm run dev');
  });

  it('includes docker section when docker is true', () => {
    const file = generateReadme({ ...baseOpts, docker: true });
    expect(file.content).toContain('docker compose up -d');
  });

  it('does not include docker section when docker is false', () => {
    const file = generateReadme({ ...baseOpts, docker: false });
    expect(file.content).not.toContain('docker compose');
  });

  it('includes template name in description', () => {
    const file = generateReadme({ ...baseOpts, template: 'swarm' });
    expect(file.content).toContain('Multi-Agent Swarm');
  });
});

describe('providerEnvKey', () => {
  it('returns OLLAMA_BASE_URL for ollama', () => {
    expect(providerEnvKey('ollama')).toBe('OLLAMA_BASE_URL');
  });

  it('returns OPENAI_API_KEY for openai', () => {
    expect(providerEnvKey('openai')).toBe('OPENAI_API_KEY');
  });

  it('returns ANTHROPIC_API_KEY for anthropic', () => {
    expect(providerEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('returns GOOGLE_API_KEY for google', () => {
    expect(providerEnvKey('google')).toBe('GOOGLE_API_KEY');
  });
});

describe('providerConfig', () => {
  it('generates valid llm config block for ollama', () => {
    const config = providerConfig('ollama');
    expect(config).toContain("defaultProvider: 'ollama'");
    expect(config).toContain('OLLAMA_BASE_URL');
    expect(config).toContain('http://localhost:11434');
  });

  it('generates valid llm config block for openai', () => {
    const config = providerConfig('openai');
    expect(config).toContain("defaultProvider: 'openai'");
    expect(config).toContain('OPENAI_API_KEY');
  });

  it('generates valid llm config block for anthropic', () => {
    const config = providerConfig('anthropic');
    expect(config).toContain("defaultProvider: 'anthropic'");
    expect(config).toContain('ANTHROPIC_API_KEY');
  });

  it('generates valid llm config block for google', () => {
    const config = providerConfig('google');
    expect(config).toContain("defaultProvider: 'google'");
    expect(config).toContain('GOOGLE_API_KEY');
  });
});
