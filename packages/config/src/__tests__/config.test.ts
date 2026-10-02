import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadConfig, defineConfig } from '../config';

describe('loadConfig', () => {
  const testConfigPath = 'test-merge-config.yaml';

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
  });

  describe('priority order', () => {
    it('overrides take precedence over env vars', () => {
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({
        skipYaml: true,
        overrides: {
          llm: { defaultModel: 'override-model' },
        },
      });

      expect(config.llm?.defaultModel).toBe('override-model');
    });

    it('env vars take precedence over YAML', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultModel: yaml-model
`
      );
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({ configPath: testConfigPath });

      expect(config.llm?.defaultModel).toBe('env-model');
    });

    it('YAML provides base config', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultProvider: openai
  defaultModel: gpt-4
limits:
  maxConcurrentRuns: 5
`
      );

      const config = loadConfig({ configPath: testConfigPath, skipEnv: true });

      expect(config.llm?.defaultProvider).toBe('openai');
      expect(config.llm?.defaultModel).toBe('gpt-4');
      expect(config.limits?.maxConcurrentRuns).toBe(5);
    });
  });

  describe('deep merge behavior', () => {
    it('merges nested objects', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  providers:
    openai:
      apiKey: yaml-key
    ollama:
      baseUrl: http://localhost:11434
`
      );

      const config = loadConfig({
        configPath: testConfigPath,
        skipEnv: true,
        overrides: {
          llm: {
            providers: {
              openai: { apiKey: 'override-key', baseUrl: 'https://custom.com' },
            },
          },
        },
      });

      expect(config.llm?.providers?.openai?.apiKey).toBe('override-key');
      expect(config.llm?.providers?.openai?.baseUrl).toBe('https://custom.com');
      expect(config.llm?.providers?.ollama?.baseUrl).toBe('http://localhost:11434');
    });

    it('replaces arrays entirely', () => {
      const config = loadConfig({
        skipYaml: true,
        skipEnv: true,
        overrides: {
          llm: { defaultProvider: 'openai' },
        },
      });

      expect(config.llm?.defaultProvider).toBe('openai');
    });
  });

  describe('skip options', () => {
    it('skipEnv prevents env loading', () => {
      process.env.COGITATOR_LLM_DEFAULT_MODEL = 'env-model';

      const config = loadConfig({ skipYaml: true, skipEnv: true });

      expect(config.llm?.defaultModel).toBeUndefined();
    });

    it('skipYaml prevents YAML loading', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultModel: yaml-model
`
      );

      const config = loadConfig({ configPath: testConfigPath, skipYaml: true, skipEnv: true });

      expect(config.llm?.defaultModel).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('throws on invalid provider', () => {
      expect(() =>
        loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            llm: { defaultProvider: 'invalid' as 'openai' },
          },
        })
      ).toThrow('Invalid configuration');
    });

    it('accepts all runtime LLM providers', () => {
      const providers = [
        'ollama',
        'openai',
        'anthropic',
        'google',
        'azure',
        'bedrock',
        'vllm',
        'mistral',
        'groq',
        'together',
        'deepseek',
      ] as const;

      for (const provider of providers) {
        const config = loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            llm: { defaultProvider: provider },
          },
        });

        expect(config.llm?.defaultProvider).toBe(provider);
      }
    });

    it('throws on invalid limits', () => {
      expect(() =>
        loadConfig({
          skipYaml: true,
          skipEnv: true,
          overrides: {
            limits: { maxConcurrentRuns: -1 },
          },
        })
      ).toThrow('Invalid configuration');
    });
  });
});

describe('defineConfig', () => {
  it('validates and returns config', () => {
    const config = defineConfig({
      llm: {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4',
      },
    });

    expect(config.llm?.defaultProvider).toBe('openai');
  });

  it('throws on invalid config', () => {
    expect(() =>
      defineConfig({
        llm: { defaultProvider: 'invalid' as 'openai' },
      })
    ).toThrow('Invalid configuration');
  });
});

describe('loadConfig hardening', () => {
  const path = 'test-hardening-config.yaml';
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_') || key.startsWith('OLLAMA_')) delete process.env[key];
    }
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
    process.env = { ...saved };
  });

  it('keeps a YAML Ollama baseUrl when only OLLAMA_API_KEY is in the environment', () => {
    writeFileSync(path, 'llm:\n  providers:\n    ollama:\n      baseUrl: http://gpu-box:11434\n');
    process.env.OLLAMA_API_KEY = 'key';
    expect(loadConfig({ configPath: path }).llm?.providers?.ollama).toEqual({
      baseUrl: 'http://gpu-box:11434',
      apiKey: 'key',
    });
  });

  it('defaults the Ollama baseUrl to Ollama Cloud for key-only configs and localhost otherwise', () => {
    process.env.OLLAMA_API_KEY = 'key';
    expect(loadConfig({ skipYaml: true }).llm?.providers?.ollama?.baseUrl).toBe(
      'https://ollama.com'
    );

    delete process.env.OLLAMA_API_KEY;
    writeFileSync(path, 'llm:\n  providers:\n    ollama: {}\n');
    expect(loadConfig({ configPath: path, skipEnv: true }).llm?.providers?.ollama?.baseUrl).toBe(
      'http://localhost:11434'
    );
  });

  it('formats validation errors with field paths', () => {
    expect(() => defineConfig({ deploy: { port: 70000 } })).toThrow(/deploy\.port/);
    expect(() => defineConfig({ deploy: { instances: 1.5 } })).toThrow(/Invalid configuration/);
  });

  it('ignores prototype-polluting keys during merge', () => {
    writeFileSync(path, '__proto__:\n  polluted: true\nllm:\n  defaultModel: x\n');
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.llm?.defaultModel).toBe('x');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
