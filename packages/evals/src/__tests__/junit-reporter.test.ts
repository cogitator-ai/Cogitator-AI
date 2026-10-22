import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitReport, junitXml } from '../reporters/junit';
import type { EvalSuiteResult } from '../reporters';

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;
const NAME = '[A-Za-z_][\\w.-]*';
const TAG = new RegExp(`<(/?)(${NAME})((?:\\s+${NAME}="[^"<]*")*)\\s*(/?)>`, 'y');
const ATTR = new RegExp(`(${NAME})="([^"<]*)"`, 'g');
const INVALID_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;

function decode(raw: string): string {
  for (let i = raw.indexOf('&'); i !== -1; i = raw.indexOf('&', i + 1)) {
    ENTITY.lastIndex = i;
    if (!ENTITY.test(raw)) throw new Error(`Bare '&' at ${i} in ${JSON.stringify(raw)}`);
  }
  return raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** A minimal XML 1.0 well-formedness check: throws on any violation, returns the root element */
function parseXml(xml: string): XmlNode {
  if (INVALID_CHAR.test(xml)) throw new Error('Character not allowed in XML 1.0');
  const declaration = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.exec(xml);
  if (!declaration) throw new Error('Missing XML declaration');

  let i = declaration[0].length;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  while (i < xml.length) {
    if (xml[i] === '<') {
      TAG.lastIndex = i;
      const match = TAG.exec(xml);
      if (!match) throw new Error(`Malformed tag at ${i}: ${xml.slice(i, i + 40)}`);
      const [whole, closing, name, rawAttrs, selfClosing] = match;
      i += whole.length;

      if (closing) {
        const open = stack.pop();
        if (open?.name !== name) throw new Error(`Unexpected </${name}>`);
        continue;
      }

      const attrs: Record<string, string> = {};
      for (const [, key, value] of rawAttrs.matchAll(ATTR)) {
        if (key in attrs) throw new Error(`Duplicate attribute ${key} on <${name}>`);
        attrs[key] = decode(value);
      }
      const node: XmlNode = { name, attrs, children: [], text: '' };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else if (root) throw new Error('More than one root element');
      else root = node;
      if (!selfClosing) stack.push(node);
    } else {
      const end = xml.indexOf('<', i);
      const raw = xml.slice(i, end === -1 ? xml.length : end);
      const parent = stack.at(-1);
      if (!parent && raw.trim() !== '') throw new Error('Text outside the root element');
      if (raw.includes('>')) throw new Error(`Unescaped '>' in text ${JSON.stringify(raw)}`);
      if (parent) parent.text += decode(raw);
      i += raw.length;
    }
  }

  if (stack.length > 0) throw new Error(`Unclosed <${stack.at(-1)?.name}>`);
  if (!root) throw new Error('No root element');
  return root;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

function makeResult(overrides?: Partial<EvalSuiteResult>): EvalSuiteResult {
  return {
    results: [
      {
        case: { input: 'What is 2+2?', expected: '4' },
        output: '4',
        duration: 120,
        scores: [
          { name: 'exactMatch', score: 1 },
          { name: 'relevance', score: 0.95, details: 'highly relevant' },
        ],
      },
      {
        case: { input: 'Translate hello' },
        output: '',
        duration: 2500,
        error: 'timed out after 2000 ms\nsecond line',
        scores: [],
      },
    ],
    aggregated: {},
    assertions: [
      { name: 'exactMatch >= 0.8', passed: false, message: 'exactMatch mean 0.5 < 0.8' },
      { name: 'relevance >= 0.7', passed: true, message: 'relevance mean 0.95 >= 0.7' },
    ],
    stats: { total: 2, errors: 1, duration: 2620, cost: 0.0012 },
    ...overrides,
  };
}

describe('junitXml', () => {
  it('builds one testsuite with a testcase per case and per assertion', () => {
    const root = parseXml(junitXml(makeResult()));

    expect(root.name).toBe('testsuites');
    expect(root.attrs).toMatchObject({ name: 'eval', tests: '4', failures: '2', time: '2.620' });
    expect(root.children).toHaveLength(1);

    const suite = root.children[0];
    expect(suite.name).toBe('testsuite');
    expect(suite.attrs).toMatchObject({
      name: 'eval',
      tests: '4',
      failures: '2',
      errors: '0',
      time: '2.620',
    });

    const [ok, errored, failedAssertion, passedAssertion] = suite.children;
    expect(suite.children.every((c) => c.name === 'testcase')).toBe(true);

    expect(ok.attrs).toMatchObject({ name: '[1] What is 2+2?', time: '0.120' });
    expect(child(ok, 'failure')).toBeUndefined();
    expect(child(ok, 'system-out')?.text).toBe('exactMatch: 1\nrelevance: 0.95 (highly relevant)');

    expect(errored.attrs).toMatchObject({ name: '[2] Translate hello', time: '2.500' });
    const failure = child(errored, 'failure');
    expect(failure?.attrs.message).toBe('timed out after 2000 ms');
    expect(failure?.text).toBe('timed out after 2000 ms\nsecond line');

    expect(failedAssertion.attrs.name).toBe('exactMatch >= 0.8');
    expect(child(failedAssertion, 'failure')?.attrs.message).toBe('exactMatch mean 0.5 < 0.8');
    expect(passedAssertion.attrs.name).toBe('relevance >= 0.7');
    expect(passedAssertion.children).toHaveLength(0);
  });

  it('escapes markup and replaces characters XML 1.0 does not allow', () => {
    const nasty = 'a <b> & "c" \'d\' \u0000\u0007 \uD800 ]]> \u{1F600}';
    const xml = junitXml(
      makeResult({
        results: [
          {
            case: { input: nasty },
            output: '',
            duration: 1,
            error: `boom ${nasty}`,
            scores: [{ name: 'm<1>', score: 0, details: '&amp; stays literal', error: 'x\u001by' }],
          },
        ],
        assertions: [{ name: 'a "quoted" <name>', passed: false, message: 'line 1\r\nline 2\t&' }],
      })
    );

    const suite = parseXml(xml).children[0];
    const [testcase, assertion] = suite.children;
    const replaced = 'a <b> & "c" \'d\' �� � ]]> \u{1F600}';

    expect(testcase.attrs.name).toBe(`[1] ${replaced}`);
    expect(child(testcase, 'failure')?.text).toBe(`boom ${replaced}`);
    expect(child(testcase, 'system-out')?.text).toBe('m<1>: 0 (&amp; stays literal) [error: x�y]');
    expect(assertion.attrs.name).toBe('a "quoted" <name>');
    expect(child(assertion, 'failure')?.text).toBe('line 1\r\nline 2\t&');
    expect(child(assertion, 'failure')?.attrs.message).toBe('line 1');
  });

  it('keeps line breaks and tabs inside attribute values', () => {
    const xml = junitXml(
      makeResult({ assertions: [{ name: 'a\tb\nc', passed: true, message: 'ok' }] })
    );

    expect(xml).toContain('name="a&#9;b&#10;c"');
    expect(parseXml(xml).children[0].children.at(-1)?.attrs.name).toBe('a\tb\nc');
  });

  it('lists the run flags of a case in its system-out', () => {
    const xml = junitXml(
      makeResult({
        results: [
          {
            case: { input: 'long answer' },
            output: 'cut',
            duration: 5,
            truncated: true,
            paused: true,
            scores: [{ name: 'exactMatch', score: 0 }],
          },
        ],
        assertions: [],
      })
    );

    const testcase = parseXml(xml).children[0].children[0];
    expect(child(testcase, 'system-out')?.text).toBe(
      'exactMatch: 0\ntruncated: true\npaused: true'
    );
    expect(child(testcase, 'failure')).toBeUndefined();
  });

  it('writes an empty suite for a run with no cases and no assertions', () => {
    const root = parseXml(
      junitXml(
        makeResult({ results: [], assertions: [], stats: { total: 0, duration: 0, cost: 0 } })
      )
    );

    expect(root.children[0].attrs).toMatchObject({ tests: '0', failures: '0', time: '0.000' });
    expect(root.children[0].children).toHaveLength(0);
  });
});

describe('junitReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'evals-junit-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the document to the given path', () => {
    const path = join(tempDir, 'eval.xml');
    junitReport(makeResult(), { path });

    expect(readFileSync(path, 'utf-8')).toBe(junitXml(makeResult()));
  });
});
