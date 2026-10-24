import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOllamaConnection } from '../utils/ollama.js';

describe('resolveOllamaConnection', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-ollama-config-'));
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|OLLAMA_|GATEWAY_)/.test(key)) delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('loads the .env next to the config and interpolates it into cogitator.yml', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://ollama.example',
        '      apiKey: ${OLLAMA_API_KEY}',
        '      headers:',
        '        X-Gateway-Key: ${GATEWAY_KEY}',
        '',
      ].join('\n')
    );
    writeFileSync(join(dir, '.env'), 'OLLAMA_API_KEY=from-env-file\nGATEWAY_KEY=from-env-file\n');

    expect(resolveOllamaConnection({ cwd: dir })).toEqual({
      baseUrl: 'http://ollama.example',
      apiKey: 'from-env-file',
      headers: { 'X-Gateway-Key': 'from-env-file' },
    });
  });

  it('reads the config COGITATOR_CONFIG points at and its .env', () => {
    writeFileSync(join(dir, 'cogitator.yml'), 'llm:\n  defaultModel: openai/gpt-6\n');
    writeFileSync(
      join(dir, 'custom.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://custom.example',
        '      headers:',
        '        X-From: ${GATEWAY_KEY}',
        '',
      ].join('\n')
    );
    writeFileSync(join(dir, '.env'), 'GATEWAY_KEY=custom-file\n');
    process.env.COGITATOR_CONFIG = 'custom.yml';

    expect(resolveOllamaConnection({ cwd: dir })).toEqual({
      baseUrl: 'http://custom.example',
      headers: { 'X-From': 'custom-file' },
    });
  });

  it('throws when COGITATOR_CONFIG points at a missing file', () => {
    writeFileSync(join(dir, 'cogitator.yml'), 'llm: {}\n');
    process.env.COGITATOR_CONFIG = 'missing.yml';

    expect(() => resolveOllamaConnection({ cwd: dir })).toThrow(
      'COGITATOR_CONFIG points to a missing file'
    );
  });

  it('does not swallow invalid unrelated configuration', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      headers:',
        '        X-Gateway-Key: secret',
        'limits:',
        '  maxConcurrentRuns: not-a-number',
        '',
      ].join('\n')
    );

    expect(() => resolveOllamaConnection({ cwd: dir })).toThrow('Invalid configuration');
  });

  it('reads no config for an explicit url, so another server gets no config credentials', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://config.example',
        '      apiKey: config-key',
        '      headers:',
        '        X-Gateway-Key: secret',
        '',
      ].join('\n')
    );

    expect(resolveOllamaConnection({ cwd: dir, url: 'http://other.example' })).toEqual({
      baseUrl: 'http://other.example',
    });
    expect(resolveOllamaConnection({ cwd: dir, url: 'http://config.example/' })).toEqual({
      baseUrl: 'http://config.example',
    });
  });

  it('does not read the config at all when a url is given, even an unreadable one', () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      ['limits:', '  maxConcurrentRuns: not-a-number', ''].join('\n')
    );
    process.env.COGITATOR_CONFIG = 'missing.yml';

    expect(resolveOllamaConnection({ cwd: dir, url: 'http://other.example' })).toEqual({
      baseUrl: 'http://other.example',
    });
  });

  it('uses the config apiKey over OLLAMA_API_KEY for the config server', () => {
    process.env.OLLAMA_API_KEY = 'env-key';
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://config.example',
        '      apiKey: literal-config-key',
        '',
      ].join('\n')
    );

    expect(resolveOllamaConnection({ cwd: dir })).toEqual({
      baseUrl: 'http://config.example',
      apiKey: 'literal-config-key',
    });
  });

  it('falls back to OLLAMA_API_KEY when the config has no key', () => {
    process.env.OLLAMA_API_KEY = 'env-key';
    writeFileSync(
      join(dir, 'cogitator.yml'),
      ['llm:', '  providers:', '    ollama:', '      baseUrl: http://config.example', ''].join('\n')
    );
    expect(resolveOllamaConnection({ cwd: dir })).toEqual({
      baseUrl: 'http://config.example',
      apiKey: 'env-key',
    });
  });
});
