import { describe, it, expect } from 'vitest';
import { adaptMarkdown, chunkMessage } from '../formatters/markdown';
import { markdownToWhatsApp } from '../formatters/whatsapp-markdown';

describe('markdownToWhatsApp regressions', () => {
  it('keeps inline code followed by digits intact', () => {
    expect(markdownToWhatsApp('run `npm test`5 times')).toBe('run `npm test`5 times');
  });

  it('converts headings to bold', () => {
    expect(markdownToWhatsApp('## Summary\ntext')).toBe('*Summary*\ntext');
  });

  it('converts links to text with url', () => {
    expect(markdownToWhatsApp('see [docs](https://example.com)')).toBe(
      'see docs (https://example.com)'
    );
  });

  it('is idempotent', () => {
    const once = markdownToWhatsApp('**bold** ~~x~~ # not heading');
    expect(markdownToWhatsApp(once)).toBe(once);
  });

  it('converts bold spanning inline code', () => {
    expect(markdownToWhatsApp('**use `x` now**')).toBe('*use `x` now*');
  });
});

describe('adaptMarkdown telegram', () => {
  it('converts **bold** to legacy *bold*', () => {
    expect(adaptMarkdown('a **b** c', 'telegram')).toBe('a *b* c');
  });

  it('turns star bullets into bullet glyphs', () => {
    expect(adaptMarkdown('* one\n* two', 'telegram')).toBe('• one\n• two');
  });

  it('leaves code untouched', () => {
    const text = '```\n# not a heading\n**x**\n```';
    expect(adaptMarkdown(text, 'telegram')).toBe(text);
  });
});

describe('adaptMarkdown slack', () => {
  it('converts links to slack format', () => {
    expect(adaptMarkdown('[site](https://a.io)', 'slack')).toBe('<https://a.io|site>');
  });

  it('escapes control characters', () => {
    expect(adaptMarkdown('a < b & c > d', 'slack')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('converts strikethrough', () => {
    expect(adaptMarkdown('~~gone~~', 'slack')).toBe('~gone~');
  });
});

describe('chunkMessage', () => {
  it('closes and reopens code fences across chunks', () => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const text = `Intro\n\`\`\`ts\n${code}\n\`\`\`\nOutro`;
    const chunks = chunkMessage(text, 60);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      const fences = chunk.split('\n').filter((l) => l.startsWith('```')).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks.join('\n')).toContain('line 19');
  });

  it('keeps indentation at the start of a chunk', () => {
    const chunks = chunkMessage('first line here\n    indented code', 17);
    expect(chunks[1]).toBe('    indented code');
  });

  it('terminates for a non-positive limit', () => {
    expect(chunkMessage('abc', 0)).toEqual(['a', 'b', 'c']);
  });

  it('handles a long single line inside a fence without looping', () => {
    const text = '```\n' + 'x'.repeat(100) + '\n```';
    const chunks = chunkMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').replace(/```|\n/g, '')).toBe('x'.repeat(100));
  });
});
