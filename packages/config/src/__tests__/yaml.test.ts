import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { loadYamlConfig } from '../loaders/yaml';

describe('loadYamlConfig', () => {
  const testConfigPath = 'test-config.yaml';
  const defaultConfigPath = 'cogitator.yaml';

  afterEach(() => {
    for (const path of [testConfigPath, defaultConfigPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  });

  describe('with explicit path', () => {
    it('loads config from specified path', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  defaultProvider: openai
  defaultModel: gpt-4
`
      );

      const config = loadYamlConfig(testConfigPath);

      expect(config).toEqual({
        llm: {
          defaultProvider: 'openai',
          defaultModel: 'gpt-4',
        },
      });
    });

    it('throws error when file not found', () => {
      expect(() => loadYamlConfig('nonexistent.yaml')).toThrow('Config file not found');
    });

    it('handles empty config file', () => {
      writeFileSync(testConfigPath, '');
      const config = loadYamlConfig(testConfigPath);
      expect(config).toBeNull();
    });

    it('parses nested provider configs', () => {
      writeFileSync(
        testConfigPath,
        `
llm:
  providers:
    openai:
      apiKey: test-key
      baseUrl: https://custom.openai.com
    ollama:
      baseUrl: http://localhost:11434
`
      );

      const config = loadYamlConfig(testConfigPath);

      expect(config?.llm?.providers?.openai).toEqual({
        apiKey: 'test-key',
        baseUrl: 'https://custom.openai.com',
      });
      expect(config?.llm?.providers?.ollama).toEqual({
        baseUrl: 'http://localhost:11434',
      });
    });

    it('parses limits config', () => {
      writeFileSync(
        testConfigPath,
        `
limits:
  maxConcurrentRuns: 10
  defaultTimeout: 30000
  maxTokensPerRun: 100000
`
      );

      const config = loadYamlConfig(testConfigPath);

      expect(config?.limits).toEqual({
        maxConcurrentRuns: 10,
        defaultTimeout: 30000,
        maxTokensPerRun: 100000,
      });
    });
  });

  describe('with default paths', () => {
    it('loads from cogitator.yaml if present', () => {
      writeFileSync(
        defaultConfigPath,
        `
llm:
  defaultProvider: anthropic
`
      );

      const config = loadYamlConfig();

      expect(config?.llm?.defaultProvider).toBe('anthropic');
    });

    it('returns null when no config file exists', () => {
      const config = loadYamlConfig();
      expect(config).toBeNull();
    });
  });
});
