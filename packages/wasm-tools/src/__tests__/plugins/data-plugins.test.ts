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
