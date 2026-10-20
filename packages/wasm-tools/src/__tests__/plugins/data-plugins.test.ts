import { describe, it, expect } from 'vitest';
import { pluginCall, runPlugin } from '../helpers/run-plugin';

const calc = pluginCall<{ result: number | null; expression: string; error?: string }>(
  'calc',
  'calculate'
);
const json = pluginCall<{ result: unknown; type: string; found?: boolean; error?: string }>(
  'json',
  'process'
);
const csv = pluginCall<{
  result: string[][] | string;
  rowCount: number;
  columnCount: number;
  headers?: string[];
  error?: string;
}>('csv', 'csv');
const xml = pluginCall<{ result: unknown; type: string; error?: string }>('xml', 'xml');
const units = pluginCall<{
  value: number | null;
  from: string;
  to: string;
  category: string;
  error?: string;
}>('units', 'units');

describe('calc plugin', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['-(2 + 3)', -5],
    ['10 % 4', 2],
    ['.5 + 2.', 2.5],
    ['7 / 2', 3.5],
  ])('evaluates %s', (expression, expected) => {
    expect(calc({ expression }).result).toBe(expected);
  });

  it('echoes the expression and reports errors', () => {
    const out = runPlugin<{ result: null; expression: string; error: string }>(
      'calc',
      'calculate',
      {
        expression: '1 / 0',
      }
    );
    expect(out.code).toBe(1);
    expect(out.output).toEqual({ result: null, expression: '1 / 0', error: 'Division by zero' });
  });

  it('rejects malformed numbers, trailing garbage and non-finite results', () => {
    expect(calc({ expression: '1.2.3' }).error).toBeDefined();
    expect(calc({ expression: '2 3' }).error).toContain('Unexpected token');
    expect(calc({ expression: '2 +' }).error).toContain('Unexpected end');
    expect(calc({ expression: '2^3' }).error).toContain('Invalid characters');
    expect(calc({ expression: '9'.repeat(400) + '*10' }).error).toContain('finite');
  });
});

describe('json plugin', () => {
  const doc = JSON.stringify({
    store: {
      books: [
        { title: 'A', price: 10, tags: ['x'] },
        { title: 'B', price: 20, tags: [] },
        { title: 'C', price: 30 },
      ],
      'key.with.dots': 1,
    },
    total: 0,
  });

  it('returns the parsed document without a query', () => {
    expect(json({ json: '[1,2]' })).toEqual({ result: [1, 2], type: 'array', found: true });
  });

  it.each([
    ['$.store.books[1].title', 'B'],
    ['store.books[-1].price', 30],
    ["$['store']['key.with.dots']", 1],
    ['$.total', 0],
  ])('resolves single-value path %s', (query, expected) => {
    expect(json({ json: doc, query }).result).toEqual(expected);
  });

  it.each([
    ['$.store.books[*].title', ['A', 'B', 'C']],
    ['$..price', [10, 20, 30]],
    ['$.store.books[0:2].price', [10, 20]],
    ['$.store.books[::-1].title', ['C', 'B', 'A']],
    ['$.store.books.*.title', ['A', 'B', 'C']],
  ])('resolves multi-value path %s', (query, expected) => {
    expect(json({ json: doc, query })).toEqual({ result: expected, type: 'array', found: true });
  });

  it('reports missing paths explicitly', () => {
    expect(json({ json: doc, query: '$.store.missing' })).toEqual({
      result: null,
      type: 'undefined',
      found: false,
    });
  });

  it('rejects unsupported syntax and invalid JSON', () => {
    expect(json({ json: doc, query: '$.store.books[?(@.price>10)]' }).error).toContain(
      'Unsupported'
    );
    expect(json({ json: '{bad', query: '$' }).type).toBe('error');
  });
});

describe('csv plugin', () => {
  it('parses RFC 4180 quoting, CRLF and BOM', () => {
    const out = csv({
      data: '﻿name,quote\r\n"Smith, J","He said ""hi"""\r\nDoe,"multi\nline"',
      operation: 'parse',
      headers: true,
    });
    expect(out.headers).toEqual(['name', 'quote']);
    expect(out.result).toEqual([
      ['Smith, J', 'He said "hi"'],
      ['Doe', 'multi\nline'],
    ]);
  });

  it('treats quotes inside unquoted fields literally', () => {
    expect(csv({ data: '5" screen,ok', operation: 'parse' }).result).toEqual([['5" screen', 'ok']]);
  });

  it('keeps a trailing empty field and supports explicit header names', () => {
    const out = csv({ data: 'a,b,\n1,2,', operation: 'parse', headers: ['x', 'y', 'z'] });
    expect(out.headers).toEqual(['x', 'y', 'z']);
    expect(out.result).toEqual([
      ['a', 'b', ''],
      ['1', '2', ''],
    ]);
  });

  it('fails on unterminated quotes and garbage after a closing quote', () => {
    expect(csv({ data: '"abc,def', operation: 'parse' }).error).toContain('Unterminated');
    expect(csv({ data: '"abc"def', operation: 'parse' }).error).toContain('after closing quote');
  });

  it('stringifies with escaping and JSON-encodes objects', () => {
    const out = csv({
      data: [
        ['a,b', 'say "x"', null, 3, { k: 1 }],
        ['line\nbreak', true],
      ],
      operation: 'stringify',
      headers: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });
    expect(out.result).toBe('c1,c2,c3,c4,c5\n"a,b","say ""x""",,3,"{""k"":1}"\n"line\nbreak",true');
  });

  it('validates data shape per operation', () => {
    expect(csv({ data: [['x']], operation: 'parse' }).error).toContain('CSV string');
    expect(csv({ data: 'x', operation: 'stringify' }).error).toContain('array of rows');
    expect(csv({ data: 'x', operation: 'parse', delimiter: '"' }).error).toContain('different');
  });
});

describe('xml plugin', () => {
  const doc =
    '<?xml version="1.0"?><!DOCTYPE lib [<!ENTITY x "y">]><lib><shelf id="1"><book lang="en">A &amp; B</book>' +
    '<book lang="de">C</book></shelf><shelf id="2"><box><book lang="fr">D &#x1F600;</book></box></shelf></lib>';

  it('supports absolute paths starting at the root element', () => {
    const out = xml({ xml: doc, query: '/lib/shelf' });
    expect(out.type).toBe('array');
    expect(out.result).toHaveLength(2);
  });

  it('supports descendant search, indexes, attributes and text()', () => {
    expect(xml({ xml: doc, query: '//book' }).result).toHaveLength(3);
    expect(xml({ xml: doc, query: '//book/@lang' }).result).toEqual(['en', 'de', 'fr']);
    expect(xml({ xml: doc, query: '/lib/shelf[2]/@id' }).result).toBe('2');
    expect(xml({ xml: doc, query: '//box/book/text()' }).result).toBe('D 😀');
    expect(xml({ xml: doc, query: 'shelf[1]/book[1]/text()' }).result).toBe('A & B');
    expect(xml({ xml: doc, query: '/lib/*' }).result).toHaveLength(2);
  });

  it('reports empty results explicitly', () => {
    expect(xml({ xml: doc, query: '//missing' })).toEqual({ result: null, type: 'empty' });
  });

  it('keeps literal ampersands that are not entities', () => {
    const out = xml({ xml: '<a>AT&T rocks; ok</a>', query: '/a/text()' });
    expect(out.result).toBe('AT&T rocks; ok');
  });

  it('rejects malformed documents', () => {
    expect(xml({ xml: '<a><b>text</a>' }).error).toContain('Mismatched');
    expect(xml({ xml: '<a><b>text' }).error).toContain('Unclosed element');
    expect(xml({ xml: '<a/><b/>' }).error).toContain('Multiple root');
    expect(xml({ xml: '<a x="1></a>' }).error).toContain('Unterminated attribute');
    expect(xml({ xml: '<a/>trailing' }).error).toContain('outside the root');
  });

  it('skips processing instructions and comments inside elements', () => {
    const out = xml({ xml: '<a><?pi data?><!-- c --><b>1</b></a>', query: '/a/b/text()' });
    expect(out.result).toBe('1');
  });
});

describe('units plugin', () => {
  it.each([
    [1000, 'mm', 'm', 1],
    [100, 'cm', 'm', 1],
    [1, 'km', 'm', 1000],
    [12, 'in', 'ft', 1],
    [1, 'ft', 'in', 12],
    [3, 'ft', 'yd', 1],
    [1, 'mi', 'ft', 5280],
    [1, 'in', 'cm', 2.54],
    [1, 'yd', 'm', 0.9144],
  ])('converts length: %d %s -> %s = %d', (value, from, to, expected) => {
    const out = units({ value, from, to });
    expect(out.category).toBe('length');
    expect(out.from).toBe(from);
    expect(out.to).toBe(to);
    expect(out.value).toBe(expected);
  });

  it.each([
    [1000, 'mg', 'g', 1],
    [1000, 'g', 'kg', 1],
    [1000, 'kg', 't', 1],
    [16, 'oz', 'lb', 1],
    [1, 'lb', 'g', 453.59237],
  ])('converts mass: %d %s -> %s = %d', (value, from, to, expected) => {
    const out = units({ value, from, to });
    expect(out.category).toBe('mass');
    expect(out.value).toBe(expected);
  });

  it.each([
    [0, 'C', 'F', 32],
    [100, 'C', 'F', 212],
    [-40, 'C', 'F', -40],
    [32, 'F', 'C', 0],
    [212, 'F', 'C', 100],
    [-40, 'F', 'C', -40],
    [0, 'C', 'K', 273.15],
    [273.15, 'K', 'C', 0],
    [32, 'F', 'K', 273.15],
    [273.15, 'K', 'F', 32],
    [0, 'K', 'F', -459.67],
    [-459.67, 'F', 'K', 0],
  ])('converts temperature with offsets: %d %s -> %s = %d', (value, from, to, expected) => {
    const out = units({ value, from, to });
    expect(out.category).toBe('temperature');
    expect(out.value).toBe(expected);
  });

  it.each([
    [1000, 'ml', 'l', 1],
    [3, 'tsp', 'tbsp', 1],
    [16, 'tbsp', 'cup', 1],
    [16, 'cup', 'US gallon', 1],
    [1, 'US gallon', 'l', 3.785411784],
    [1, 'imperial gallon', 'l', 4.54609],
    [1, 'imperial gallon', 'US gallon', 1.2009499255],
  ])('converts volume: %d %s -> %s = %d', (value, from, to, expected) => {
    const out = units({ value, from, to });
    expect(out.category).toBe('volume');
    expect(out.value).toBe(expected);
  });

  it.each([
    [1, 'm/s', 'km/h', 3.6],
    [36, 'km/h', 'm/s', 10],
    [1, 'mph', 'm/s', 0.44704],
    [1, 'knot', 'km/h', 1.852],
  ])('converts speed: %d %s -> %s = %d', (value, from, to, expected) => {
    const out = units({ value, from, to });
    expect(out.category).toBe('speed');
    expect(out.value).toBe(expected);
  });

  it.each([
    [1, 'KB', 'B', 1000],
    [1, 'KiB', 'B', 1024],
    [1, 'MB', 'KB', 1000],
    [1, 'MiB', 'KiB', 1024],
    [1, 'GB', 'MB', 1000],
    [1, 'GiB', 'MiB', 1024],
    [1, 'TB', 'GB', 1000],
    [1, 'TiB', 'GiB', 1024],
    [1, 'GiB', 'GB', 1.073741824],
    [1000, 'MB', 'GiB', 0.931322574615],
  ])(
    'distinguishes decimal and binary data units: %d %s -> %s = %d',
    (value, from, to, expected) => {
      const out = units({ value, from, to });
      expect(out.category).toBe('data');
      expect(out.value).toBe(expected);
    }
  );

  it('rejects lowercase or bit-style data abbreviations', () => {
    for (const unit of ['b', 'Mb', 'mb', 'kb', 'gb', 'tb', 'kib', 'mib']) {
      const res = runPlugin<{ error?: string }>('units', 'units', {
        value: 1,
        from: unit,
        to: 'B',
      });
      expect(res.code).toBe(1);
      expect(res.output.error).toContain(`Unknown unit "${unit}". Supported units:`);
    }
  });

  it('rejects cross-category conversions and lists supported units', () => {
    const res = runPlugin<{ error?: string }>('units', 'units', {
      value: 1,
      from: 'kg',
      to: 'm',
    });
    expect(res.code).toBe(1);
    expect(res.output.error).toContain('mass');
    expect(res.output.error).toContain('length');
    expect(res.output.error).toContain('kg');
    expect(res.output.error).toContain('km');
  });

  it('rejects unknown units and lists supported categories and units', () => {
    const res = runPlugin<{ error?: string }>('units', 'units', {
      value: 1,
      from: 'furlong',
      to: 'm',
    });
    expect(res.code).toBe(1);
    expect(res.output.error).toContain('Unknown unit "furlong". Supported units:');
    expect(res.output.error).toContain('length');
    expect(res.output.error).toContain('temperature');
    expect(res.output.error).toContain('data');
  });
});
