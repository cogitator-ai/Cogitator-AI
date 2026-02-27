import { describe, it, expect } from 'vitest';
import { adaptMarkdown, chunkMessage, getPlatformLimit } from '@cogitator-ai/channels';

describe('Channels E2E: Formatters', () => {
  describe('adaptMarkdown', () => {
    it('converts headers to emphasized text for telegram', () => {
      const input = '# Main Title\n\nSome content\n\n## Sub heading\n\nMore content';
      const result = adaptMarkdown(input, 'telegram');
      expect(result).toContain('*Main Title*');
      expect(result).toContain('*Sub heading*');
      expect(result).not.toContain('#');
    });

    it('converts bold syntax for slack', () => {
      const input = '**bold text** and normal';
      const result = adaptMarkdown(input, 'slack');
      expect(result).toContain('*bold text*');
    });

    it('passes through for discord unchanged (discord supports standard md)', () => {
      const input = '# Title\n**bold** and `code`';
      const result = adaptMarkdown(input, 'discord');
      expect(result).toBe(input);
    });

    it('handles mixed markdown elements', () => {
      const input = [
        '# Report',
        '',
        'Here is **important** data:',
        '',
        '```python',
        'print("hello")',
        '```',
        '',
        '- Item 1',
        '- Item 2',
      ].join('\n');

      const telegramResult = adaptMarkdown(input, 'telegram');
      expect(telegramResult).toContain('*Report*');
      expect(telegramResult).toContain('**important**');
      expect(telegramResult).toContain('```python');

      const slackResult = adaptMarkdown(input, 'slack');
      expect(slackResult).toContain('*important*');
      expect(slackResult).toContain('```');
    });
  });

  describe('chunkMessage', () => {
    it('does not chunk short messages', () => {
      const chunks = chunkMessage('Hello world', 4096);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Hello world');
    });

    it('chunks at paragraph boundaries', () => {
      const para1 = 'A'.repeat(50);
      const para2 = 'B'.repeat(50);
      const text = `${para1}\n\n${para2}`;

      const chunks = chunkMessage(text, 60);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(para1);
      expect(chunks[1]).toBe(para2);
    });

    it('chunks at line boundaries when paragraphs are too large', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}: ${'x'.repeat(20)}`);
      const text = lines.join('\n');

      const chunks = chunkMessage(text, 100);
      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(100);
      }

      const reconstructed = chunks.join('\n');
      expect(reconstructed).toBe(text);
    });

    it('handles very long words by splitting at character boundary', () => {
      const longWord = 'A'.repeat(200);
      const chunks = chunkMessage(longWord, 100);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(100);
      expect(chunks[1].length).toBe(100);
    });
  });

  describe('getPlatformLimit', () => {
    it('returns correct limits per platform', () => {
      expect(getPlatformLimit('telegram')).toBe(4096);
      expect(getPlatformLimit('discord')).toBe(2000);
      expect(getPlatformLimit('slack')).toBe(40000);
      expect(getPlatformLimit('whatsapp')).toBe(65536);
    });

    it('returns default limit for unknown platforms', () => {
      const limit = getPlatformLimit('custom');
      expect(limit).toBeGreaterThan(0);
    });
  });

  describe('integration: adapt + chunk for platform', () => {
    it('adapts then chunks a long markdown response for telegram', () => {
      const sections = Array.from(
        { length: 20 },
        (_, i) => `## Section ${i}\n\n${'Lorem ipsum '.repeat(30)}`
      );
      const markdown = sections.join('\n\n');

      const adapted = adaptMarkdown(markdown, 'telegram');
      const limit = getPlatformLimit('telegram');
      const chunks = chunkMessage(adapted, limit);

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
      }

      expect(chunks.length).toBeGreaterThan(1);
      expect(adapted).not.toContain('## ');
      expect(adapted).toContain('*Section');
    });
  });
});
