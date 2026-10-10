import { describe, expect, it } from 'vitest';
import { fitText, graphemeLength, graphemes, splitText, threadsLength } from '../feeds/text';

const family = '👨‍👩‍👧';
const flag = '🇺🇦';
const keycap = '1️⃣';

describe('measuring text', () => {
  it('counts what a reader sees as one character once on Bluesky', () => {
    expect(graphemeLength('hello')).toBe(5);
    expect(graphemeLength(family)).toBe(1);
    expect(family.length).toBe(8);
    expect(graphemeLength(`${flag}${keycap}é`)).toBe(3);
    expect(graphemeLength('日本語')).toBe(3);
  });

  it('counts emoji by their UTF-8 bytes on Threads and everything else once', () => {
    expect(threadsLength('hello')).toBe(5);
    expect(threadsLength('😀')).toBe(4);
    expect(threadsLength(family)).toBe(new TextEncoder().encode(family).length);
    expect(threadsLength(flag)).toBe(8);
    expect(threadsLength(keycap)).toBe(new TextEncoder().encode(keycap).length);
    expect(threadsLength('日本語')).toBe(3);
    expect(threadsLength('é')).toBe(1);
  });

  it('never splits a grapheme', () => {
    expect(graphemes(`a${family}b`)).toEqual(['a', family, 'b']);
  });
});

describe('fitting text', () => {
  it('leaves text that fits alone', () => {
    expect(fitText('short', 10)).toBe('short');
  });

  it('cuts at a word with an ellipsis', () => {
    const fitted = fitText('The quick brown fox jumps over the lazy dog', 20);
    expect(fitted).toBe('The quick brown fox…');
    expect(graphemeLength(fitted)).toBeLessThanOrEqual(20);
  });

  it('cuts mid-word when no word boundary is in the second half', () => {
    expect(fitText('Supercalifragilisticexpialidocious', 10)).toBe('Supercali…');
  });

  it('drops trailing punctuation before the ellipsis', () => {
    expect(fitText('First part, second part, third part', 13)).toBe('First part…');
  });

  it('keeps emoji whole and within the Threads count', () => {
    const text = `${'😀'.repeat(3)} and more words after the emoji`;
    const fitted = fitText(text, 16, threadsLength);
    expect(threadsLength(fitted)).toBeLessThanOrEqual(16);
    expect(fitted.startsWith('😀😀😀')).toBe(true);
    expect(fitted.endsWith('…')).toBe(true);
  });

  it('returns only what fits of the ellipsis when there is no room for text', () => {
    expect(fitText('abcdef', 2, graphemeLength, '...')).toBe('..');
  });
});

describe('splitting text', () => {
  it('returns nothing for blank text and one part for text that fits', () => {
    expect(splitText('   ', 10)).toEqual([]);
    expect(splitText(' fits ', 10)).toEqual(['fits']);
  });

  it('keeps paragraphs whole where they fit', () => {
    const text = 'First paragraph here.\n\nSecond one.\n\nThird paragraph is here.';
    expect(splitText(text, 30)).toEqual([
      'First paragraph here.',
      'Second one.',
      'Third paragraph is here.',
    ]);
    expect(splitText(text, 40)).toEqual([
      'First paragraph here.\n\nSecond one.',
      'Third paragraph is here.',
    ]);
  });

  it('splits a long paragraph at words and a long word mid-word', () => {
    const parts = splitText('one two three four five six seven', 10);
    expect(parts).toEqual(['one two', 'three four', 'five six', 'seven']);
    expect(splitText('abcdefghijklmnop', 5)).toEqual(['abcde', 'fghij', 'klmno', 'p']);
  });

  it('keeps every part within the limit as the feed counts it', () => {
    const text = `${'😀 '.repeat(200)}\n\n${'word '.repeat(300)}`;
    for (const [measure, max] of [
      [graphemeLength, 300],
      [threadsLength, 500],
    ] as const) {
      const parts = splitText(text, max, measure);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) expect(measure(part)).toBeLessThanOrEqual(max);
      expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
    }
  });

  it('refuses a limit below one', () => {
    expect(() => splitText('text', 0)).toThrow(RangeError);
  });
});
