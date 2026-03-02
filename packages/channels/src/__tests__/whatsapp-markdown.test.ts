import { describe, it, expect } from 'vitest';
import { markdownToWhatsApp } from '../formatters/whatsapp-markdown';

describe('markdownToWhatsApp', () => {
  it('converts **bold** to *bold*', () => {
    expect(markdownToWhatsApp('This is **bold** text')).toBe('This is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToWhatsApp('This is __bold__ text')).toBe('This is *bold* text');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(markdownToWhatsApp('This is ~~deleted~~ text')).toBe('This is ~deleted~ text');
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\n**bold** and ~~strike~~\n```';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it('preserves inline code untouched', () => {
    const input = 'Use `**not bold**` in code';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it('handles mixed formatting in one message', () => {
    const input = '**Hello** and ~~world~~ with `code` and ```block```';
    const result = markdownToWhatsApp(input);
    expect(result).toBe('*Hello* and ~world~ with `code` and ```block```');
  });

  it('returns empty string as-is', () => {
    expect(markdownToWhatsApp('')).toBe('');
  });

  it('returns null/undefined as-is', () => {
    expect(markdownToWhatsApp(null as unknown as string)).toBe(null);
    expect(markdownToWhatsApp(undefined as unknown as string)).toBe(undefined);
  });

  it('handles multiple bold segments', () => {
    expect(markdownToWhatsApp('**one** and **two**')).toBe('*one* and *two*');
  });

  it('leaves single * italic as-is', () => {
    expect(markdownToWhatsApp('This is *italic* text')).toBe('This is *italic* text');
  });

  it('preserves code blocks with language specifier', () => {
    const input = '```typescript\nconst x = **not bold**;\n```';
    expect(markdownToWhatsApp(input)).toBe(input);
  });
});
