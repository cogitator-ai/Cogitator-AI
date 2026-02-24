import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfig } from '../commands/run.js';

describe('findConfig', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-run-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the explicit config path if it exists', () => {
    const configPath = join(tempDir, 'my.yml');
    writeFileSync(configPath, 'llm:\n  defaultProvider: ollama');
    const result = findConfig(configPath);
    expect(result).toBeTruthy();
    expect(result).toContain('my.yml');
  });

  it('returns null if explicit config path does not exist', () => {
    const result = findConfig(join(tempDir, 'nonexistent.yml'));
    expect(result).toBeNull();
  });

  it('finds cogitator.yml in current dir when default path given', () => {
    writeFileSync(join(tempDir, 'cogitator.yml'), 'llm:\n  defaultProvider: ollama');
    const result = findConfig('cogitator.yml');
    expect(result).toBeTruthy();
    expect(result).toContain('cogitator.yml');
  });

  it('finds cogitator.yaml when cogitator.yml not present', () => {
    writeFileSync(join(tempDir, 'cogitator.yaml'), 'llm:\n  defaultProvider: ollama');
    const result = findConfig('cogitator.yml');
    expect(result).toBeTruthy();
    expect(result).toContain('cogitator.yaml');
  });

  it('finds cogitator.json when yml not present', () => {
    writeFileSync(join(tempDir, 'cogitator.json'), '{"llm": {}}');
    const result = findConfig('cogitator.yml');
    expect(result).toBeTruthy();
    expect(result).toContain('cogitator.json');
  });

  it('uses COGITATOR_CONFIG env var when set', () => {
    const envConfig = join(tempDir, 'env-config.yml');
    writeFileSync(envConfig, 'llm:\n  defaultProvider: openai');
    process.env.COGITATOR_CONFIG = envConfig;

    try {
      const result = findConfig('cogitator.yml');
      expect(result).toBeTruthy();
      expect(result).toContain('env-config.yml');
    } finally {
      delete process.env.COGITATOR_CONFIG;
    }
  });

  it('returns null when no config file found', () => {
    const result = findConfig('cogitator.yml');
    expect(result).toBeNull();
  });
});
