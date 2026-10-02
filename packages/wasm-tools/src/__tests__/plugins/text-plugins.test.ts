import { describe, it, expect } from 'vitest';
import { pluginCall } from '../helpers/run-plugin';

const markdown = pluginCall<{ html: string; error?: string }>('markdown', 'markdown');
const regex = pluginCall<{ result: unknown; matchCount?: number; error?: string }>(
  'regex',
  'regex'
);
const datetime = pluginCall<{
  result: string | number;
  iso: string;
  unix: number;
  formatted?: string;
  error?: string;
}>('datetime', 'datetime');
const diff = pluginCall<{ diff: string; additions: number; deletions: number; error?: string }>(
  'diff',
  'diff'
);
const slug = pluginCall<{ slug: string; error?: string }>('slug', 'slug');
const validate = pluginCall<{ valid: boolean; normalized?: string; error?: string }>(
  'validation',
  'validate'
);

describe('markdown plugin', () => {
  it('neutralizes dangerous URL schemes when sanitizing', () => {
    const html = markdown({
      markdown: '[a](javascript:alert(1)) ![i](data:text/html,x) [b](JaVaScRiPt:alert(1))',
    }).html;
    expect(html).not.toMatch(/javascript:|data:/i);
    expect(html).toContain('<a href="#">a</a>');
    expect(html).toContain('<img src="#" alt="i">');
  });

  it('keeps safe and relative links, including parentheses in URLs', () => {
    const html = markdown({
      markdown: '[w](https://en.wikipedia.org/wiki/Foo_(bar)) [r](/docs?a=1&b=2) <https://x.com>',
    }).html;
    expect(html).toContain('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a>');
    expect(html).toContain('<a href="/docs?a=1&amp;b=2">r</a>');
    expect(html).toContain('<a href="https://x.com">https://x.com</a>');
  });

  it('escapes code fence languages and code content', () => {
    const html = markdown({ markdown: '```js" onmouseover="x\n<b>hi</b>\n```' }).html;
    expect(html).toBe('<pre><code class="language-js&quot;">&lt;b&gt;hi&lt;/b&gt;</code></pre>');
  });

  it('escapes raw HTML when sanitizing and passes it through otherwise', () => {
    expect(markdown({ markdown: '<script>x</script>' }).html).toBe(
      '<p>&lt;script&gt;x&lt;/script&gt;</p>'
    );
    expect(markdown({ markdown: '<b>raw</b>', options: { sanitize: false } }).html).toBe(
      '<p><b>raw</b></p>'
    );
  });

  it('does not apply emphasis inside code spans or intraword underscores', () => {
    const html = markdown({ markdown: 'my_var_name `a*b*c` *em* __strong__ \\*lit\\*' }).html;
    expect(html).toBe(
      '<p>my_var_name <code>a*b*c</code> <em>em</em> <strong>strong</strong> *lit*</p>'
    );
  });

  it('renders GFM tables only with a separator row, keeping empty cells and alignment', () => {
    const html = markdown({ markdown: '| a | b | c |\n|:--|--:|:-:|\n| 1 | | 3 |' }).html;
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right"></td>');
    expect(html).toContain('<td style="text-align:center">3</td>');

    expect(markdown({ markdown: 'a | b\nc | d' }).html).toBe('<p>a | b c | d</p>');
  });

  it('supports ordered list start numbers, closing hashes and spaced rules', () => {
    expect(markdown({ markdown: '3. three\n4. four' }).html).toBe(
      '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>'
    );
    expect(markdown({ markdown: '## Title ##' }).html).toBe('<h2>Title</h2>');
    expect(markdown({ markdown: '* * *' }).html).toBe('<hr>');
  });
});

describe('regex plugin', () => {
  it('runs match operations', () => {
    expect(
      regex({ text: 'a1b22c333', pattern: '\\d+', flags: 'g', operation: 'matchAll' }).matchCount
    ).toBe(3);
    expect(
      regex({ text: 'a-b', pattern: '-', operation: 'replace', replacement: '+' }).result
    ).toBe('a+b');
    expect(regex({ text: 'abc', pattern: 'x', operation: 'matchAll', limit: 0 }).result).toEqual(
      []
    );
  });

  it.each(['(a+)+$', '(\\w+\\s?)+$', '((ab)*)+', '(x+){2,}', '(?:a|b+)*c', '([a-z]+)*'])(
    'rejects catastrophic pattern %s',
    (pattern) => {
      expect(regex({ text: 'aaaa', pattern, operation: 'test' }).error).toContain('ReDoS');
    }
  );

  it.each([
    '(\\d+)-(\\d+)-(\\w+)-(\\s*)',
    '(cat|dog)+',
    '[(]+\\)',
    '\\(a+\\)+',
    '(ab)+c',
    '(a{1,3})+',
  ])('accepts safe pattern %s', (pattern) => {
    expect(regex({ text: 'x', pattern, operation: 'test' }).error).toBeUndefined();
  });
});

describe('datetime plugin', () => {
  it('clamps month and year arithmetic to the end of the month', () => {
    expect(
      datetime({ date: '2024-01-31T10:00:00Z', operation: 'add', amount: 1, unit: 'months' }).result
    ).toBe('2024-02-29T10:00:00.000Z');
    expect(
      datetime({ date: '2024-02-29', operation: 'add', amount: 1, unit: 'years' }).result
    ).toBe('2025-02-28T00:00:00.000Z');
    expect(
      datetime({ date: '2024-03-31', operation: 'subtract', amount: 1, unit: 'months' }).result
    ).toBe('2024-02-29T00:00:00.000Z');
  });

  it('formats every token occurrence and supports literals', () => {
    const out = datetime({
      date: '2024-03-10T10:05:07.089+04:00',
      operation: 'format',
      format: 'YYYY-MM-DD [at] HH:mm:ss.SSS Z (YYYY)',
      timezone: '+04:00',
    });
    expect(out.result).toBe('2024-03-10 at 10:05:07.089 +04:00 (2024)');
  });

  it('parses flexible ISO forms and rejects impossible dates', () => {
    expect(datetime({ date: '2024-05-01 12:30', operation: 'parse' }).result).toBe(
      '2024-05-01T12:30:00.000Z'
    );
    expect(datetime({ date: '2024-05-01T12:30:00.123456Z', operation: 'parse' }).result).toBe(
      '2024-05-01T12:30:00.123Z'
    );
    expect(datetime({ date: '0099-01-01', operation: 'parse' }).result).toBe(
      '0099-01-01T00:00:00.000Z'
    );
    expect(datetime({ date: '2023-02-29', operation: 'parse' }).error).toContain('Invalid day');
    expect(datetime({ date: '2024-13-01', operation: 'parse' }).error).toContain('Invalid month');
    expect(
      datetime({ date: '2024-01-01', operation: 'format', timezone: '+25:00' }).error
    ).toContain('out of range');
  });

  it('computes signed calendar differences', () => {
    const diffOf = (date: string, endDate: string, unit: string) =>
      datetime({ date, endDate, operation: 'diff', unit }).result;
    expect(diffOf('2024-01-31', '2024-02-28', 'months')).toBe(0);
    expect(diffOf('2024-01-31', '2024-02-29', 'months')).toBe(1);
    expect(diffOf('2024-01-31', '2024-03-31', 'months')).toBe(2);
    expect(diffOf('2024-03-31', '2024-01-31', 'months')).toBe(-2);
    expect(diffOf('2020-02-29', '2024-02-28', 'years')).toBe(3);
    expect(diffOf('2024-01-02T00:00:00Z', '2024-01-01T01:00:00Z', 'days')).toBe(0);
    expect(
      datetime({ date: '2024-01-01', endDate: '2024-01-02', operation: 'diff', unit: 'weeks' })
        .error
    ).toContain('Unknown unit');
  });
});

describe('diff plugin', () => {
  it('produces a standard unified diff with hunk headers', () => {
    const out = diff({ original: 'a\nb\nc\n', modified: 'a\nB\nc\n' });
    expect(out.diff).toBe('--- original\n+++ modified\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    expect(out.additions).toBe(1);
    expect(out.deletions).toBe(1);
  });

  it('splits distant changes into separate hunks with correct ranges', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const modified = original.replace('line2', 'LINE2').replace('line18', 'LINE18');
    const lines = diff({ original, modified, context: 1 }).diff.split('\n');
    expect(lines.filter((l) => l.startsWith('@@'))).toEqual([
      '@@ -1,3 +1,3 @@',
      '@@ -17,3 +17,3 @@',
    ]);
  });

  it('handles insertions into empty text and identical inputs', () => {
    expect(diff({ original: '', modified: 'x' }).diff).toBe(
      '--- original\n+++ modified\n@@ -0,0 +1 @@\n+x'
    );
    expect(diff({ original: 'same', modified: 'same' })).toMatchObject({
      diff: '',
      additions: 0,
      deletions: 0,
    });
    expect(diff({ original: 'a', modified: 'b', context: -1 }).error).toContain('context');
  });
});

describe('slug plugin', () => {
  it.each([
    ['Hello, World!', 'hello-world'],
    ['hello/world', 'hello-world'],
    ["Don't stop", 'dont-stop'],
    ['Привет, Мир!', 'privet-mir'],
    ['Crème brûlée à la façon', 'creme-brulee-a-la-facon'],
    ['  --Spaces--  ', 'spaces'],
  ])('slugifies %s', (text, expected) => {
    expect(slug({ text }).slug).toBe(expected);
  });

  it('supports custom separators and maxLength', () => {
    expect(slug({ text: 'Hello Big World', separator: '_' }).slug).toBe('hello_big_world');
    expect(slug({ text: 'one two three four', maxLength: 12 }).slug).toBe('one-two');
    expect(slug({ text: 'x', maxLength: 0 }).error).toContain('maxLength');
  });
});

describe('validation plugin', () => {
  it.each([
    ['user@example.com', true],
    ['First.Last+tag@Example.COM', true],
    ['a..b@example.com', false],
    ['.a@example.com', false],
    ['a@-bad.com', false],
    ['a@example.com.', false],
    [`${'x'.repeat(65)}@example.com`, false],
  ])('email %s -> %s', (value, valid) => {
    expect(validate({ value, type: 'email' }).valid).toBe(valid);
  });

  it('normalizes only the email domain case', () => {
    expect(validate({ value: 'John.Doe@Example.COM', type: 'email' }).normalized).toBe(
      'John.Doe@example.com'
    );
  });

  it.each([
    ['1.2.3.4', true],
    ['255.255.255.255', true],
    ['256.1.1.1', false],
    ['01.2.3.4', false],
    ['1.2.3', false],
  ])('ipv4 %s -> %s', (value, valid) => {
    expect(validate({ value, type: 'ipv4' }).valid).toBe(valid);
  });

  it.each([
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['::1', '::1'],
    ['::', '::'],
    ['fe80::0:0:1', 'fe80::1'],
    ['::ffff:192.168.0.1', '::ffff:192.168.0.1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
  ])('ipv6 %s normalizes to %s', (value, normalized) => {
    expect(validate({ value, type: 'ipv6' })).toMatchObject({ valid: true, normalized });
  });

  it.each(['1::2::3', ':1', '1:2:3:4:5:6:7:8:9', 'gggg::1', '::ffff:999.0.0.1', 'fe80::1%eth0'])(
    'rejects invalid ipv6 %s',
    (value) => {
      expect(validate({ value, type: 'ipv6' }).valid).toBe(false);
    }
  );

  it.each([
    ['https://example.com/path?q=1#frag', true, 'https://example.com/path?q=1#frag'],
    ['HTTP://User:pw@EXAMPLE.com:8080/x', true, 'http://User:pw@example.com:8080/x'],
    ['http://[2001:db8::1]:443/', true, 'http://[2001:db8::1]:443/'],
    ['example.com', true, 'https://example.com'],
    ['http://[garbage]/', false, undefined],
    ['javascript:alert(1)', false, undefined],
    ['http://exa mple.com', false, undefined],
    ['http://host:99999', false, undefined],
    ['http://', false, undefined],
  ])('url %s', (value, valid, normalized) => {
    const out = validate({ value, type: 'url' });
    expect(out.valid).toBe(valid);
    expect(out.normalized).toBe(normalized);
  });
});
