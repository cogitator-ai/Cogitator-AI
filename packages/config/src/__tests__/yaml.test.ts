import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { interpolateEnv, interpolateEnvString, loadYamlConfig } from '../loaders/yaml';

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
    groq:
      apiKey: groq-key
    azure:
      apiKey: azure-key
      endpoint: https://example.openai.azure.com
      deployment: gpt-4o
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
      expect(config?.llm?.providers?.groq).toEqual({
        apiKey: 'groq-key',
      });
      expect(config?.llm?.providers?.azure?.deployment).toBe('gpt-4o');
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

describe('environment interpolation', () => {
  const path = 'interp-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('substitutes ${VAR} references in YAML values', () => {
    writeFileSync(
      path,
      'llm:\n  providers:\n    openai:\n      apiKey: ${TEST_OPENAI_KEY}\n      baseUrl: ${TEST_BASE:-https://api.openai.com/v1}\n'
    );
    const config = loadYamlConfig(path, { TEST_OPENAI_KEY: 'sk-123' });
    expect(config?.llm?.providers?.openai).toEqual({
      apiKey: 'sk-123',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('supports defaults, unset-only defaults and $$ escapes', () => {
    const env = { EMPTY: '', SET: 'x' };
    expect(interpolateEnvString('${MISSING:-d}', env)).toBe('d');
    expect(interpolateEnvString('${EMPTY:-d}', env)).toBe('d');
    expect(interpolateEnvString('${EMPTY-d}', env)).toBe('');
    expect(interpolateEnvString('${MISSING-d}', env)).toBe('d');
    expect(interpolateEnvString('${SET}/${MISSING}', env)).toBe('x/');
    expect(interpolateEnvString('price: $$5 ${SET}', env)).toBe('price: $5 x');
    expect(interpolateEnvString('$HOME stays', env)).toBe('$HOME stays');
  });

  it('interpolates nested arrays and leaves non-strings untouched', () => {
    const date = new Date(0);
    expect(interpolateEnv({ a: ['${X}', 1, true, null], d: date }, { X: 'y' })).toEqual({
      a: ['y', 1, true, null],
      d: date,
    });
  });

  it('rejects files whose top level is not a mapping', () => {
    writeFileSync(path, '- just\n- a list\n');
    expect(() => loadYamlConfig(path)).toThrow('must contain a mapping');
  });

  it('includes the file path in YAML syntax errors', () => {
    writeFileSync(path, 'llm: [unclosed\n');
    expect(() => loadYamlConfig(path)).toThrow(`Failed to parse config file ${path}`);
  });
});
