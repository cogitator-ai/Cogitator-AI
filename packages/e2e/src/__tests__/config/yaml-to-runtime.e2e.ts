import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadDotenvFile } from '@cogitator-ai/config';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { getOllamaUrl, getTestModel, isOllamaRunning } from '../../helpers/setup';

describe('Config: YAML file → runtime config', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-e2e-'));
  });

  afterAll(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves ${VAR} references, .env values and provider env vars together', () => {
    const configPath = join(dir, 'cogitator.yml');
    writeFileSync(
      configPath,
      [
        'llm:',
        '  defaultProvider: ollama',
        '  defaultModel: ollama/${E2E_MODEL:-fallback-model}',
        '  providers:',
        '    openai:',
        '      apiKey: ${E2E_OPENAI_KEY}',
        '    ollama:',
        '      baseUrl: ${E2E_OLLAMA_URL:-http://localhost:11434}',
        'deploy:',
        '  port: ${E2E_PORT:-3000}',
      ].join('\n')
    );
    writeFileSync(join(dir, '.env'), 'E2E_OPENAI_KEY="sk-from-dotenv"\n');

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_') || key.startsWith('OLLAMA_')) delete process.env[key];
    }
    Object.assign(process.env, loadDotenvFile(join(dir, '.env')), {
      E2E_MODEL: 'qwen2.5:0.5b',
      OLLAMA_API_KEY: 'cloud-key',
    });

    expect(() => loadConfig({ configPath })).toThrow(/deploy\.port/);

    writeFileSync(
      configPath,
      [
        'llm:',
        '  defaultProvider: ollama',
        '  defaultModel: ollama/${E2E_MODEL:-fallback-model}',
        '  providers:',
        '    openai:',
        '      apiKey: ${E2E_OPENAI_KEY}',
        '    ollama:',
        '      baseUrl: ${E2E_OLLAMA_URL:-http://localhost:11434}',
      ].join('\n')
    );

    const config = loadConfig({ configPath });
    expect(config.llm?.defaultModel).toBe('ollama/qwen2.5:0.5b');
    expect(config.llm?.providers?.openai?.apiKey).toBe('sk-from-dotenv');
    expect(config.llm?.providers?.ollama).toEqual({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
    });
  });
});

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeOllama('Config: YAML-configured Cogitator runs against Ollama', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-e2e-ollama-'));
  });

  afterAll(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a prompt using only values from cogitator.yml', async ({ skip }) => {
    if (!(await isOllamaRunning())) skip();

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_') || key.startsWith('OLLAMA_')) delete process.env[key];
    }
    process.env.E2E_OLLAMA_URL = getOllamaUrl();

    const configPath = join(dir, 'cogitator.yml');
    writeFileSync(
      configPath,
      [
        'llm:',
        '  defaultProvider: ollama',
        `  defaultModel: ollama/${getTestModel()}`,
        '  providers:',
        '    ollama:',
        '      baseUrl: ${E2E_OLLAMA_URL}',
      ].join('\n')
    );

    const config = loadConfig({ configPath });
    const cog = new Cogitator(config);
    try {
      const agent = new Agent({
        name: 'config-e2e',
        model: config.llm?.defaultModel ?? '',
        instructions: 'Answer in one short sentence.',
      });
      const result = await cog.run(agent, { input: 'What is 2 + 2? Answer with the number.' });
      expect(result.output).toMatch(/4|four/i);
    } finally {
      await cog.close();
    }
  });
});
