import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findAssistantConfig, loadAssistantConfig, RESTART_EXIT_CODE } from '../commands/up.js';
import { parseTailOption } from '../commands/logs.js';

describe('assistant config loading', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-up-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds cogitator.yml or cogitator.yaml', () => {
    expect(findAssistantConfig(dir)).toBeNull();
    writeFileSync(join(dir, 'cogitator.yaml'), '');
    expect(findAssistantConfig(dir)).toBe(join(dir, 'cogitator.yaml'));
    writeFileSync(join(dir, 'cogitator.yml'), '');
    expect(findAssistantConfig(dir)).toBe(join(dir, 'cogitator.yml'));
  });

  it('parses a valid config and applies defaults', () => {
    const path = join(dir, 'cogitator.yml');
    writeFileSync(
      path,
      'name: jarvis\npersonality: helpful\nllm:\n  provider: ollama\n  model: qwen2.5:0.5b\n'
    );
    const config = loadAssistantConfig(path);
    expect(config.name).toBe('jarvis');
    expect(config.memory.adapter).toBe('sqlite');
    expect(config.channels).toEqual({});
  });

  it('reports validation issues with their paths', () => {
    const path = join(dir, 'cogitator.yml');
    writeFileSync(path, 'name: jarvis\nllm:\n  provider: nope\n  model: x\n');
    expect(() => loadAssistantConfig(path)).toThrow(/personality[\s\S]*llm\.provider/);
  });

  it('uses the same restart exit code as the self-config tools', () => {
    expect(RESTART_EXIT_CODE).toBe(78);
  });
});

describe('parseTailOption', () => {
  it('accepts numbers and "all"', () => {
    expect(parseTailOption('50')).toBe('50');
    expect(parseTailOption('all')).toBe('all');
  });

  it('rejects anything else', () => {
    expect(() => parseTailOption('-5')).toThrow();
    expect(() => parseTailOption('ten')).toThrow();
  });
});
