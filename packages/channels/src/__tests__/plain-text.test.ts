import { describe, expect, it } from 'vitest';
import { markdownToPlainText } from '../formatters/plain-text';
import { adaptMarkdown, getPlatformLimit } from '../formatters/markdown';

describe('markdownToPlainText', () => {
  it('drops headings, emphasis and code marks, keeping the words', () => {
    expect(markdownToPlainText('# Title\n\n**Bold**, *italic*, _under_, ~~gone~~ and `code`')).toBe(
      'Title\n\nBold, italic, under, gone and code'
    );
  });

  it('keeps code blocks as they are, without the fences', () => {
    expect(markdownToPlainText('Run:\n\n```bash\npnpm add **x**\n```\n\nDone')).toBe(
      'Run:\n\npnpm add **x**\n\nDone'
    );
  });

  it('shows the URL of links and images so the feed can link them', () => {
    expect(
      markdownToPlainText(
        'See [the story](https://e.com/a) or [https://e.com](https://e.com) ![chart](https://e.com/c.png)'
      )
    ).toBe('See the story (https://e.com/a) or https://e.com chart: https://e.com/c.png');
  });

  it('turns list items into bullets and unwraps quotes', () => {
    expect(markdownToPlainText('- one\n* two\n  + nested\n> quoted\n\n---\n\nend')).toBe(
      '• one\n• two\n  • nested\nquoted\n\nend'
    );
  });

  it('leaves snake_case and arithmetic alone', () => {
    expect(markdownToPlainText('use snake_case_name and 2 * 3 * 4')).toBe(
      'use snake_case_name and 2 * 3 * 4'
    );
  });

  it('is what Bluesky and Threads get from the gateway, unlimited since they split by grapheme', () => {
    expect(adaptMarkdown('**hi**', 'bluesky')).toBe('hi');
    expect(adaptMarkdown('**hi**', 'threads')).toBe('hi');
    expect(getPlatformLimit('bluesky')).toBe(Infinity);
  });
});
