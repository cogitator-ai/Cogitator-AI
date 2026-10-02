import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatEnvLine,
  formatEnvValue,
  loadDotenvInto,
  mergeEnvContent,
  parseDotenv,
} from '../utils/env.js';

describe('formatEnvValue', () => {
  it('leaves simple values unquoted', () => {
    expect(formatEnvValue('sk-abc_123')).toBe('sk-abc_123');
    expect(formatEnvValue('https://ollama.com')).toBe('https://ollama.com');
  });

  it('quotes and escapes values with special characters', () => {
    expect(formatEnvValue('a b')).toBe('"a b"');
    expect(formatEnvValue('x#y')).toBe('"x#y"');
    expect(formatEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatEnvValue('line1\nline2')).toBe('"line1\\nline2"');
  });

  it('round-trips through parseDotenv', () => {
    const values = [
      'plain',
      'with space',
      'quote"inside',
      'back\\slash',
      'multi\nline',
      'hash # x',
    ];
    const content = values.map((v, i) => formatEnvLine(`K${i}`, v)).join('\n');
    const parsed = parseDotenv(content);
    values.forEach((v, i) => expect(parsed[`K${i}`]).toBe(v));
  });
});

describe('mergeEnvContent', () => {
  it('preserves comments, blank lines and order', () => {
    const existing = '# LLM keys\nGOOGLE_API_KEY=old\n\n# other\nFOO=bar\n';
    const merged = mergeEnvContent(existing, new Map([['GOOGLE_API_KEY', 'new']]));
    expect(merged).toBe('# LLM keys\nGOOGLE_API_KEY=new\n\n# other\nFOO=bar\n');
  });

  it('appends new keys and replaces duplicates everywhere', () => {
    const existing = 'A=1\nA=2\n';
    const merged = mergeEnvContent(
      existing,
      new Map([
        ['A', '3'],
        ['B', 'x y'],
      ])
    );
    expect(merged).toBe('A=3\nA=3\nB="x y"\n');
  });

  it('handles an empty file', () => {
    expect(mergeEnvContent('', new Map([['TG_TOKEN', 't']]))).toBe('TG_TOKEN=t\n');
  });

  it('recognises export-prefixed lines', () => {
    expect(mergeEnvContent('export TOKEN=a\n', new Map([['TOKEN', 'b']]))).toBe('TOKEN=b\n');
  });
});

describe('loadDotenvInto', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-env-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not override variables already set', () => {
    writeFileSync(join(dir, '.env'), 'A=file\nB="quoted value"\n');
    const env: Record<string, string | undefined> = { A: 'process' };
    loadDotenvInto(join(dir, '.env'), env);
    expect(env).toEqual({ A: 'process', B: 'quoted value' });
  });

  it('is a no-op when the file is missing', () => {
    const env: Record<string, string | undefined> = {};
    loadDotenvInto(join(dir, 'missing.env'), env);
    expect(env).toEqual({});
  });
});
