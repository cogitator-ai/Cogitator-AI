import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfig, pickOllamaModel, resolveRunModel } from '../commands/run.js';

describe('findConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-run-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the explicit config path if it exists', () => {
    writeFileSync(join(tempDir, 'my.yml'), 'llm:\n  defaultProvider: ollama');
    expect(findConfig('my.yml', {}, tempDir)).toBe(join(tempDir, 'my.yml'));
  });

  it('returns null if explicit config path does not exist, even when defaults exist', () => {
    writeFileSync(join(tempDir, 'cogitator.yml'), 'llm: {}');
    expect(findConfig('nonexistent.yml', {}, tempDir)).toBeNull();
  });

  it('explicit path wins over COGITATOR_CONFIG', () => {
    writeFileSync(join(tempDir, 'explicit.yml'), 'llm: {}');
    writeFileSync(join(tempDir, 'env.yml'), 'llm: {}');
    const result = findConfig('explicit.yml', { COGITATOR_CONFIG: 'env.yml' }, tempDir);
    expect(result).toBe(join(tempDir, 'explicit.yml'));
  });

  it('uses COGITATOR_CONFIG when no explicit path is given', () => {
    writeFileSync(join(tempDir, 'env-config.yml'), 'llm: {}');
    writeFileSync(join(tempDir, 'cogitator.yml'), 'llm: {}');
    const result = findConfig(undefined, { COGITATOR_CONFIG: 'env-config.yml' }, tempDir);
    expect(result).toBe(join(tempDir, 'env-config.yml'));
  });

  it('returns null when COGITATOR_CONFIG points to a missing file', () => {
    writeFileSync(join(tempDir, 'cogitator.yml'), 'llm: {}');
    expect(findConfig(undefined, { COGITATOR_CONFIG: 'missing.yml' }, tempDir)).toBeNull();
  });

  it.each(['cogitator.yml', 'cogitator.yaml', 'cogitator.json', '.cogitator.yml'])(
    'discovers %s in the working directory',
    (name) => {
      writeFileSync(join(tempDir, name), 'llm: {}');
      expect(findConfig(undefined, {}, tempDir)).toBe(join(tempDir, name));
    }
  );

  it('prefers cogitator.yml over cogitator.json', () => {
    writeFileSync(join(tempDir, 'cogitator.json'), '{}');
    writeFileSync(join(tempDir, 'cogitator.yml'), 'llm: {}');
    expect(findConfig(undefined, {}, tempDir)).toBe(join(tempDir, 'cogitator.yml'));
  });

  it('returns null when no config file found', () => {
    expect(findConfig(undefined, {}, tempDir)).toBeNull();
  });
});

describe('resolveRunModel', () => {
  it('prefers the --model flag', () => {
    expect(
      resolveRunModel(
        'openai/gpt-4o',
        { COGITATOR_MODEL: 'ollama/x' },
        { llm: { defaultModel: 'y' } }
      )
    ).toBe('openai/gpt-4o');
  });

  it('falls back to COGITATOR_MODEL, then config defaultModel', () => {
    expect(resolveRunModel(undefined, { COGITATOR_MODEL: 'ollama/x' }, {})).toBe('ollama/x');
    expect(
      resolveRunModel(undefined, {}, { llm: { defaultModel: 'google/gemini-2.5-flash' } })
    ).toBe('google/gemini-2.5-flash');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveRunModel(undefined, {}, {})).toBeUndefined();
    expect(resolveRunModel('', { COGITATOR_MODEL: '' }, {})).toBeUndefined();
  });
});

describe('pickOllamaModel', () => {
  it('returns null for an empty list', () => {
    expect(pickOllamaModel([])).toBeNull();
  });

  it('picks a preferred model when available', () => {
    expect(pickOllamaModel(['qwen2.5:0.5b', 'gemma3:4b'])).toBe('ollama/gemma3:4b');
  });

  it('falls back to the first model', () => {
    expect(pickOllamaModel(['qwen2.5:0.5b', 'phi3'])).toBe('ollama/qwen2.5:0.5b');
  });
});
