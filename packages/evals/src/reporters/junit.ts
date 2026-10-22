import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';
import { caseFlags, caseLabel } from './format';

const SUITE_NAME = 'eval';

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Replaces the characters XML 1.0 does not allow, lone surrogates included, with U+FFFD */
function xmlSafe(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += isXmlChar(code) ? ch : '�';
  }
  return out;
}

/** Escapes text content, `\r` kept as a reference since parsers fold a raw one into `\n` */
function escapeText(value: string): string {
  return xmlSafe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/** Escapes an attribute value, keeping tabs and line breaks that a parser would fold to spaces */
function escapeAttr(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;');
}

function attrs(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`)
    .join('');
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

type CaseResult = EvalSuiteResult['results'][number];

function caseOutput(result: CaseResult): string {
  const lines = result.scores.map((s) => {
    const details = s.details ? ` (${s.details})` : '';
    const error = s.error !== undefined ? ` [error: ${s.error}]` : '';
    return `${s.name}: ${s.score}${details}${error}`;
  });
  for (const flag of caseFlags(result)) lines.push(`${flag}: true`);
  return lines.join('\n');
}

function caseTestcase(result: CaseResult, index: number): string {
  const head = `    <testcase${attrs({
    name: caseLabel(index, result.case.input),
    classname: `${SUITE_NAME}.cases`,
    time: seconds(result.duration),
  })}`;
  const body: string[] = [];
  if (result.error !== undefined) {
    body.push(
      `      <failure${attrs({ message: firstLine(result.error), type: 'CaseError' })}>${escapeText(result.error)}</failure>`
    );
  }
  const output = caseOutput(result);
  if (output !== '') body.push(`      <system-out>${escapeText(output)}</system-out>`);
  return body.length === 0 ? `${head}/>` : `${head}>\n${body.join('\n')}\n    </testcase>`;
}

function assertionTestcase(assertion: EvalSuiteResult['assertions'][number]): string {
  const head = `    <testcase${attrs({
    name: assertion.name,
    classname: `${SUITE_NAME}.assertions`,
    time: seconds(0),
  })}`;
  if (assertion.passed) return `${head}/>`;
  return `${head}>\n      <failure${attrs({ message: firstLine(assertion.message), type: 'AssertionFailure' })}>${escapeText(assertion.message)}</failure>\n    </testcase>`;
}

/** The JUnit XML document of a suite run: one testcase per case and one per assertion */
export function junitXml(result: EvalSuiteResult): string {
  const tests = result.results.length + result.assertions.length;
  const failures =
    result.results.filter((r) => r.error !== undefined).length +
    result.assertions.filter((a) => !a.passed).length;
  const time = seconds(result.stats.duration);
  const counts = { tests, failures, errors: 0, skipped: 0, time };

  const testcases = [
    ...result.results.map((r, i) => caseTestcase(r, i)),
    ...result.assertions.map((a) => assertionTestcase(a)),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attrs({ name: SUITE_NAME, tests, failures, errors: 0, time })}>`,
    `  <testsuite${attrs({ name: SUITE_NAME, ...counts })}${testcases.length === 0 ? '/>' : '>'}`,
    ...(testcases.length === 0 ? [] : [...testcases, '  </testsuite>']),
    '</testsuites>',
    '',
  ].join('\n');
}

/** Writes the suite run as JUnit XML, which CI systems show as a test report */
export function junitReport(result: EvalSuiteResult, options: { path: string }): void {
  writeFileSync(options.path, junitXml(result), 'utf-8');
}
