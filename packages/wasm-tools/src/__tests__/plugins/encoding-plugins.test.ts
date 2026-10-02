import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { pluginCall, runPlugin } from '../helpers/run-plugin';

const base64 = pluginCall<{ result: string; operation: string; error?: string }>(
  'base64',
  'base64'
);
const hash = pluginCall<{ hash: string; algorithm: string; error?: string }>('hash', 'hash');

const SAMPLES = [
  '',
  'a',
  'foo',
  'foob',
  'héllo wörld?',
  'Привет мир',
  '😀 emoji \u{1F680}',
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(64),
  'Привет'.repeat(40),
];

describe('hash plugin', () => {
  it.each(['md5', 'sha1', 'sha256'] as const)('matches node:crypto for %s', (algorithm) => {
    for (const text of SAMPLES) {
      const expected = createHash(algorithm).update(text, 'utf8').digest('hex');
      expect(hash({ text, algorithm }).hash).toBe(expected);
    }
  });

  it('encodes lone surrogates as U+FFFD like TextEncoder', () => {
    const text = 'lone \uD800 surrogate';
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    expect(hash({ text, algorithm: 'sha256' }).hash).toBe(expected);
  });

  it('reports unsupported algorithms', () => {
    const result = runPlugin<{ error?: string }>('hash', 'hash', { text: 'x', algorithm: 'sha3' });
    expect(result.code).toBe(1);
    expect(result.output.error).toContain('Unsupported algorithm');
  });
});

describe('base64 plugin', () => {
  it('encodes like Buffer for standard and URL-safe variants', () => {
    for (const text of SAMPLES) {
      expect(base64({ text, operation: 'encode' }).result).toBe(
        Buffer.from(text, 'utf8').toString('base64')
      );
      expect(base64({ text, operation: 'encode', urlSafe: true }).result).toBe(
        Buffer.from(text, 'utf8').toString('base64url')
      );
    }
  });

  it('round-trips through decode', () => {
    for (const text of SAMPLES) {
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      expect(base64({ text: encoded, operation: 'decode' }).result).toBe(text);
    }
  });

  it('decodes both alphabets regardless of urlSafe flag and ignores whitespace', () => {
    expect(base64({ text: '+/+/', operation: 'decode', urlSafe: true }).result).toBe(
      Buffer.from('+/+/', 'base64').toString('utf8')
    );
    expect(base64({ text: 'Zm9v YmFy\n', operation: 'decode' }).result).toBe('foobar');
    expect(base64({ text: 'aGk', operation: 'decode' }).result).toBe('hi');
  });

  it('replaces invalid UTF-8 with U+FFFD instead of failing', () => {
    expect(base64({ text: '/w==', operation: 'decode' }).result).toBe('�');
  });

  it('rejects invalid characters and lengths with an error', () => {
    const invalid = runPlugin<{ error?: string; operation: string }>('base64', 'base64', {
      text: '!!!',
      operation: 'decode',
    });
    expect(invalid.code).toBe(1);
    expect(invalid.output.error).toContain('Invalid base64');
    expect(invalid.output.operation).toBe('decode');

    expect(base64({ text: 'abcde', operation: 'decode' }).error).toContain('incorrect length');
    expect(base64({ text: 'ab=c', operation: 'decode' }).error).toContain('padding');
  });
});
