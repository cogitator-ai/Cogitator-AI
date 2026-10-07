import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfig, loadRunConfig, resolveRunModel } from '../commands/run.js';

describe('cogitator run config', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-run-config-'));
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|OLLAMA_)/.test(key)) {
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('runs the model of an assistant config from cogitator wizard, with its .env', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      'name: Jarvis\npersonality: helpful\nllm:\n  provider: anthropic\n  model: claude-sonnet-5-5\nchannels: {}\n'
    );
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-from-file\n');

    const loaded = loadRunConfig(join(dir, 'cogitator.yml'), dir);

    expect(loaded.kind).toBe('assistant');
    expect(loaded.model).toBe('anthropic/claude-sonnet-5-5');
    expect(loaded.config.llm?.providers?.anthropic?.apiKey).toBe('sk-ant-from-file');
    expect(resolveRunModel(undefined, {}, loaded.config, loaded.model)).toBe(
      'anthropic/claude-sonnet-5-5'
    );
  });

  it('keeps a provider-prefixed assistant model as it is', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      'name: A\npersonality: p\nllm:\n  provider: openai\n  model: openai/gpt-6\n'
    );
    expect(loadRunConfig(join(dir, 'cogitator.yml'), dir).model).toBe('openai/gpt-6');
  });

  it('loads a runtime config and the .env next to it, without overriding the environment', () => {
    writeFileSync(join(dir, 'cogitator.yml'), 'llm:\n  defaultModel: openai/gpt-6\n');
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=from-file\nOPENAI_BASE_URL=https://file\n');
    process.env.OPENAI_BASE_URL = 'https://shell';

    const loaded = loadRunConfig(join(dir, 'cogitator.yml'), dir);

    expect(loaded.kind).toBe('runtime');
    expect(loaded.model).toBeUndefined();
    expect(loaded.config.llm?.defaultModel).toBe('openai/gpt-6');
    expect(loaded.config.llm?.providers?.openai).toMatchObject({
      apiKey: 'from-file',
      baseUrl: 'https://shell',
    });
  });

  it('loads the .env of the working directory without a config file', () => {
    writeFileSync(join(dir, '.env'), 'COGITATOR_LLM_DEFAULT_MODEL=google/gemini-3.8-flash\n');
    const loaded = loadRunConfig(null, dir);
    expect(loaded.kind).toBeUndefined();
    expect(loaded.config.llm?.defaultModel).toBe('google/gemini-3.8-flash');
  });

  it('finds .cogitator.yml before cogitator.json', () => {
    writeFileSync(join(dir, 'cogitator.json'), '{}');
    writeFileSync(join(dir, '.cogitator.yml'), 'llm: {}\n');
    expect(findConfig(undefined, {}, dir)).toBe(join(dir, '.cogitator.yml'));
  });
});
