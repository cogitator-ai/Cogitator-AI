import { describe, expect, it } from 'vitest';
import { normalizeMath } from '../ui/math.js';

describe('normalizeMath', () => {
  it('turns \\( \\) into inline math and \\[ \\] into a display block', () => {
    expect(normalizeMath('So \\(17.5 \\div 100 \\times 2480 = 434\\).')).toBe(
      'So $$17.5 \\div 100 \\times 2480 = 434$$.'
    );
    expect(normalizeMath('Area:\n\\[ \\pi r^2 \\]\nDone')).toBe(
      'Area:\n\n\n$$\n\\pi r^2\n$$\n\n\nDone'
    );
  });

  it('leaves code, prices and unclosed delimiters alone', () => {
    const code = '```ts\nconst s = "\\(x\\)";\n```\nand `\\(y\\)`';
    expect(normalizeMath(code)).toBe(code);
    expect(normalizeMath('It costs $5, or $10 with tax.')).toBe('It costs $5, or $10 with tax.');
    expect(normalizeMath('streaming \\(x + ')).toBe('streaming \\(x + ');
    expect(normalizeMath('empty \\( \\) stays')).toBe('empty \\( \\) stays');
  });

  it('keeps math inside a table cell inline', () => {
    expect(normalizeMath('| a | \\(x^2\\) |')).toBe('| a | $$x^2$$ |');
  });

  it('runs in linear time on unclosed delimiters', () => {
    const hostile = '\\('.repeat(20_000);
    const started = performance.now();
    expect(normalizeMath(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
