import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotenvFile, parseDotenv } from '../loaders/dotenv';

describe('parseDotenv', () => {
  it('parses plain, exported and quoted values', () => {
    const env = parseDotenv(
      [
        '# comment',
        'PLAIN=value',
        'export EXPORTED=1',
        'SPACED = padded ',
        'DOUBLE="a \\"quoted\\" line\\nnext"',
        "SINGLE='keep \\n literal'",
        'INLINE=value # trailing comment',
        'HASH_IN_QUOTES="a # b"',
        'EMPTY=',
        'not a line',
      ].join('\n')
    );
    expect(env).toEqual({
      PLAIN: 'value',
      EXPORTED: '1',
      SPACED: 'padded',
      DOUBLE: 'a "quoted" line\nnext',
      SINGLE: 'keep \\n literal',
      INLINE: 'value',
      HASH_IN_QUOTES: 'a # b',
      EMPTY: '',
    });
  });

  it('handles CRLF line endings and later duplicates win', () => {
    expect(parseDotenv('A=1\r\nB=2\r\nA=3')).toEqual({ A: '3', B: '2' });
  });

  it('keeps values containing "=" intact', () => {
    expect(parseDotenv('URL=postgres://u:p@h/db?x=1')).toEqual({ URL: 'postgres://u:p@h/db?x=1' });
  });
});

describe('loadDotenvFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-dotenv-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty object for missing files', () => {
    expect(loadDotenvFile(join(dir, '.env'))).toEqual({});
  });

  it('reads and parses a file', () => {
    writeFileSync(join(dir, '.env'), 'TOKEN=abc\n');
    expect(loadDotenvFile(join(dir, '.env'))).toEqual({ TOKEN: 'abc' });
  });
});
