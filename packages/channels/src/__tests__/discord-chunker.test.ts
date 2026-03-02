import { describe, it, expect } from 'vitest';
import { chunkDiscordText } from '../formatters/discord-chunker';

describe('chunkDiscordText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkDiscordText('Hello world')).toEqual(['Hello world']);
  });

  it('returns empty array for empty string', () => {
    expect(chunkDiscordText('')).toEqual([]);
  });

  it('splits long text at character limit', () => {
    const text = 'a'.repeat(2500);
    const chunks = chunkDiscordText(text, { maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('preserves code block integrity across chunk boundary', () => {
    const codeBlock = '```js\n' + 'const x = 1;\n'.repeat(50) + '```';
    const text = 'Some intro text\n\n' + codeBlock;
    const chunks = chunkDiscordText(text, { maxChars: 200 });

    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('closes and reopens fence when splitting inside code block', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const text = '```\n' + lines + '\n```';
    const chunks = chunkDiscordText(text, { maxChars: 200 });

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const backtickCount = (chunk.match(/```/g) ?? []).length;
      expect(backtickCount % 2).toBe(0);
    }
  });

  it('handles nested code fences (``` inside ~~~)', () => {
    const text = '~~~\nsome text\n```\ninner\n```\nmore text\n~~~';
    const chunks = chunkDiscordText(text, { maxChars: 2000 });
    expect(chunks).toEqual([text]);
  });

  it('splits by line count limit', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n');
    const chunks = chunkDiscordText(lines, { maxLines: 17 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits long single line at word boundary', () => {
    const words = Array.from({ length: 500 }, () => 'word').join(' ');
    const chunks = chunkDiscordText(words, { maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('rebalances reasoning italics across chunks', () => {
    const body = Array.from({ length: 40 }, (_, i) => `reasoning line ${i}`).join('\n');
    const text = `Reasoning:\n_${body}_`;
    const chunks = chunkDiscordText(text, { maxLines: 17 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      expect(trimmed.endsWith('_')).toBe(true);
    }
  });

  it('does not rebalance italics for non-reasoning text', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkDiscordText(lines, { maxLines: 17 });
    expect(chunks.length).toBeGreaterThan(1);

    const hasTrailingUnderscore = chunks.some((c) => c.trimEnd().endsWith('_'));
    expect(hasTrailingUnderscore).toBe(false);
  });

  it('respects custom maxChars and maxLines', () => {
    const text = 'Hello\nWorld\nFoo\nBar\nBaz';
    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 3 });
    expect(chunks.length).toBe(2);
  });
});
