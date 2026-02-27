import { describe, it, expect } from 'vitest';
import { adaptMarkdown, chunkMessage, getPlatformLimit } from '../formatters/markdown';

describe('adaptMarkdown', () => {
  it('converts headers for telegram', () => {
    const result = adaptMarkdown('# Title\n## Subtitle\n### Heading', 'telegram');
    expect(result).toBe('*Title*\n*Subtitle*\n*Heading*');
  });

  it('converts bold for slack', () => {
    const result = adaptMarkdown('This is **bold** text', 'slack');
    expect(result).toBe('This is *bold* text');
  });

  it('passes through for discord', () => {
    const text = '# Title\n**bold** text';
    expect(adaptMarkdown(text, 'discord')).toBe(text);
  });

  it('passes through for webchat', () => {
    const text = '# Title\n**bold** text';
    expect(adaptMarkdown(text, 'webchat')).toBe(text);
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(chunkMessage('Hello', 100)).toEqual(['Hello']);
  });

  it('splits at paragraph boundary', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkMessage(text, 30);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it('splits at line boundary when no paragraph break', () => {
    const text = 'Line one\nLine two\nLine three\nLine four';
    const chunks = chunkMessage(text, 20);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits at word boundary as last resort', () => {
    const text = 'Short words in a long sentence that exceeds the limit';
    const chunks = chunkMessage(text, 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('getPlatformLimit', () => {
  it('returns correct limits', () => {
    expect(getPlatformLimit('telegram')).toBe(4096);
    expect(getPlatformLimit('discord')).toBe(2000);
    expect(getPlatformLimit('slack')).toBe(40000);
    expect(getPlatformLimit('webchat')).toBe(Infinity);
  });

  it('returns default for unknown platform', () => {
    expect(getPlatformLimit('unknown')).toBe(4096);
  });
});
