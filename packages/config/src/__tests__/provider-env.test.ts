import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config';
import { loadEnvConfig, loadEnvDefaults } from '../loaders/env';
import { findConfigFile, CONFIG_FILE_NAMES } from '../loaders/yaml';
import { resolveOllamaHost } from '../ollama';
import { PROVIDER_ENV, providerEnvNames } from '../provider-env';

const savedEnv = { ...process.env };

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(COGITATOR_|OLLAMA_|AWS_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_)/.test(key)) {
      delete process.env[key];
    }
  }
}

describe('Bedrock credentials from the environment', () => {
  beforeEach(clearProviderEnv);
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('leaves AWS_* credentials to the SDK chain, so a session token is never dropped', () => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_ACCESS_KEY_ID = 'ASIA-temporary';
    process.env.AWS_SECRET_ACCESS_KEY = 'temporary-secret';
    process.env.AWS_SESSION_TOKEN = 'session-token';

    const bedrock = loadConfig({ skipYaml: true }).llm?.providers?.bedrock;
    expect(bedrock).toEqual({ region: 'eu-west-1' });
  });

  it('keeps Bedrock available when only AWS credentials are in the environment', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-aws';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    expect(loadEnvConfig().llm?.providers?.bedrock).toEqual({});
  });

  it('reads static credentials, a session token and a profile from COGITATOR_BEDROCK_*', () => {
    process.env.COGITATOR_BEDROCK_ACCESS_KEY_ID = 'ASIA-explicit';
    process.env.COGITATOR_BEDROCK_SECRET_ACCESS_KEY = 'explicit-secret';
    process.env.COGITATOR_BEDROCK_SESSION_TOKEN = 'explicit-token';
    process.env.COGITATOR_BEDROCK_PROFILE = 'ci';

    expect(loadConfig({ skipYaml: true }).llm?.providers?.bedrock).toEqual({
      accessKeyId: 'ASIA-explicit',
      secretAccessKey: 'explicit-secret',
      sessionToken: 'explicit-token',
      profile: 'ci',
    });
  });

  it('accepts a session token and a profile in cogitator.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-bedrock-'));
    const path = join(dir, 'cogitator.yml');
    writeFileSync(
      path,
      'llm:\n  providers:\n    bedrock:\n      region: us-east-1\n      sessionToken: tok\n      profile: dev\n'
    );
    try {
      expect(loadConfig({ configPath: path, skipEnv: true }).llm?.providers?.bedrock).toEqual({
        region: 'us-east-1',
        sessionToken: 'tok',
        profile: 'dev',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveOllamaHost', () => {
  it.each([
    ['0.0.0.0', 'http://localhost:11434'],
    ['0.0.0.0:11500', 'http://localhost:11500'],
    ['[::]:11434', 'http://localhost:11434'],
    [':11434', 'http://localhost:11434'],
    ['gpu-box', 'http://gpu-box:11434'],
    ['gpu-box:8080', 'http://gpu-box:8080'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://gpu-box:11434/', 'http://gpu-box:11434'],
    ['http://gpu-box', 'http://gpu-box'],
    ['https://ollama.com', 'https://ollama.com'],
    ['https://proxy.example.com/ollama/', 'https://proxy.example.com/ollama'],
    ['[2001:db8::1]', 'http://[2001:db8::1]:11434'],
  ])('reads %s the way Ollama does', (raw, expected) => {
    expect(resolveOllamaHost(raw)).toBe(expected);
  });

  it('ignores empty values', () => {
    expect(resolveOllamaHost('  ')).toBeUndefined();
    expect(resolveOllamaHost(undefined)).toBeUndefined();
  });
});

describe('Ollama base URL precedence', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    clearProviderEnv();
    dir = mkdtempSync(join(tmpdir(), 'cfg-ollama-'));
    path = join(dir, 'cogitator.yml');
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns OLLAMA_HOST=0.0.0.0 (set for "ollama serve") into a reachable URL', () => {
    process.env.OLLAMA_HOST = '0.0.0.0';
    expect(loadConfig({ skipYaml: true }).llm?.providers?.ollama?.baseUrl).toBe(
      'http://localhost:11434'
    );
  });

  it('keeps an explicit YAML baseUrl over OLLAMA_HOST and OLLAMA_URL', () => {
    writeFileSync(path, 'llm:\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n');
    process.env.OLLAMA_HOST = '0.0.0.0';
    process.env.OLLAMA_URL = 'http://other:11434';
    expect(loadConfig({ configPath: path }).llm?.providers?.ollama?.baseUrl).toBe(
      'http://gpu-box:11434'
    );
  });

  it('lets COGITATOR_OLLAMA_BASE_URL override the YAML baseUrl', () => {
    writeFileSync(path, 'llm:\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n');
    process.env.COGITATOR_OLLAMA_BASE_URL = 'http://override:11434';
    expect(loadConfig({ configPath: path }).llm?.providers?.ollama?.baseUrl).toBe(
      'http://override:11434'
    );
  });

  it('reads OLLAMA_BASE_URL, the variable create-cogitator-app projects use', () => {
    process.env.OLLAMA_BASE_URL = 'http://lan-box:11434';
    process.env.OLLAMA_HOST = '0.0.0.0';
    expect(loadEnvDefaults().llm?.providers?.ollama?.baseUrl).toBe('http://lan-box:11434');
    expect(loadEnvConfig().llm?.providers?.ollama).toBeUndefined();
  });
});

describe('findConfigFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-find-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers cogitator.yml, then cogitator.yaml, then the dotfiles', () => {
    expect(findConfigFile(dir)).toBeUndefined();
    for (const name of [...CONFIG_FILE_NAMES].reverse()) {
      writeFileSync(join(dir, name), 'llm: {}\n');
      expect(findConfigFile(dir)).toBe(join(dir, name));
    }
    expect(CONFIG_FILE_NAMES[0]).toBe('cogitator.yml');
  });

  it('is what loadConfig reads without a configPath', () => {
    const cwd = process.cwd();
    writeFileSync(join(dir, 'cogitator.yaml'), 'llm:\n  defaultModel: from-yaml\n');
    writeFileSync(join(dir, 'cogitator.yml'), 'llm:\n  defaultModel: from-yml\n');
    process.chdir(dir);
    try {
      expect(loadConfig({ skipEnv: true }).llm?.defaultModel).toBe('from-yml');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('PROVIDER_ENV', () => {
  it('lists every variable loadEnvConfig reads for a provider', () => {
    const google = PROVIDER_ENV.google.find((s) => s.field === 'apiKey');
    expect(google && providerEnvNames(google)).toEqual([
      'COGITATOR_GOOGLE_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
    ]);
  });

  it('marks what a provider cannot run without', () => {
    const required = (provider: keyof typeof PROVIDER_ENV) =>
      PROVIDER_ENV[provider].filter((s) => s.required).map((s) => s.field);
    expect(required('azure')).toEqual(['apiKey', 'endpoint']);
    expect(required('bedrock')).toEqual(['region', 'accessKeyId', 'secretAccessKey']);
    expect(required('ollama')).toEqual([]);
    expect(required('together')).toEqual(['apiKey']);
  });

  it('reads every non-SDK variable it lists', () => {
    clearProviderEnv();
    try {
      for (const [provider, settings] of Object.entries(PROVIDER_ENV)) {
        for (const setting of settings) {
          for (const name of [...setting.env, ...(setting.fallbackEnv ?? [])]) {
            clearProviderEnv();
            for (const other of settings) {
              if (other.required && other !== setting) {
                process.env[other.env[0]] = 'other-value';
              }
            }
            process.env[name] = setting.field === 'baseUrl' ? 'http://host:1' : 'value';
            const providers = {
              ...loadEnvDefaults().llm?.providers,
              ...loadEnvConfig().llm?.providers,
            };
            const config: unknown = Reflect.get(providers, provider);
            expect(
              typeof config === 'object' && config !== null && setting.field in config,
              `${name} -> ${provider}.${setting.field}`
            ).toBe(true);
          }
        }
      }
    } finally {
      process.env = { ...savedEnv };
    }
  });
});
