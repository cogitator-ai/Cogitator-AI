import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findAssistantConfig,
  loadAssistantConfig,
  loadAssistantEnv,
  RESTART_EXIT_CODE,
} from '../commands/up.js';
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

describe('loadAssistantEnv', () => {
  const KEY = 'COGITATOR_UP_TEST_GITHUB_TOKEN';
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-up-env-'));
  });
  afterEach(() => {
    delete process.env[KEY];
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes .env values on process.env for tools that read it', () => {
    writeFileSync(join(dir, '.env'), `${KEY}=ghp_from_file\n`);

    loadAssistantEnv(join(dir, 'cogitator.yml'));

    expect(process.env[KEY]).toBe('ghp_from_file');
  });

  it('does not override variables that are already set', () => {
    writeFileSync(join(dir, '.env'), 'TAVILY_API_KEY=from_file\nBRAVE_API_KEY=brave_file\n');
    const target: NodeJS.ProcessEnv = { TAVILY_API_KEY: 'from_shell' };

    loadAssistantEnv(join(dir, 'cogitator.yml'), target);

    expect(target).toEqual({ TAVILY_API_KEY: 'from_shell', BRAVE_API_KEY: 'brave_file' });
  });

  it('ignores a missing .env file', () => {
    const target: NodeJS.ProcessEnv = { A: '1' };
    loadAssistantEnv(join(dir, 'cogitator.yml'), target);
    expect(target).toEqual({ A: '1' });
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
