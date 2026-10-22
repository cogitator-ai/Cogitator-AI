import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report, reportPath } from '../reporters';
import type { EvalSuiteResult } from '../reporters';
import { markdownSummary, MARKDOWN_MAX_FAILURES } from '../reporters/markdown';
import { htmlPage } from '../reporters/html';
import { comparisonHtml, comparisonMarkdown, reportComparison } from '../reporters/comparison';
import { EvalSuite } from '../eval-suite';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import { exactMatch } from '../metrics/deterministic';
import { compareRuns } from '../runs';
import type { RunComparison } from '../runs';

const aggregate = (name: string, mean: number, count?: number) => ({
  name,
  mean,
  median: mean,
  min: 0,
  max: 1,
  stdDev: 0.1,
  p50: mean,
  p95: 1,
  p99: 1,
  ...(count !== undefined && { count }),
});

function makeResult(overrides: Partial<EvalSuiteResult> = {}): EvalSuiteResult {
  return {
    name: 'qa <agent>',
    runId: 'run-1',
    results: [
      {
        case: { input: 'What is 2+2?', expected: '4' },
        output: '4',
        duration: 120,
        traceId: 'trace-abc',
        prompt: { key: 'support', versionId: 'ver_2', version: 2 },
        scores: [{ name: 'exactMatch', score: 1 }],
      },
      {
        case: { input: 'Say <script>alert(1)</script> | now' },
        output: '<img src=x onerror=alert(1)>\nsecond line',
        duration: 250,
        scores: [{ name: 'exactMatch', score: 0, error: 'judge <b>broke</b>' }],
      },
      {
        case: { input: 'Timeout case' },
        output: '',
        duration: 3000,
        error: 'Timed out after 3000ms',
        scores: [],
      },
    ],
    aggregated: { exactMatch: aggregate('exactMatch', 0.5, 2) },
    assertions: [
      {
        name: 'threshold(exactMatch)',
        passed: false,
        message: 'exactMatch = 0.5, expected >= 0.9',
      },
      { name: 'maxErrorRate(0.5)', passed: true, message: 'ok' },
    ],
    stats: { total: 3, errors: 1, metricErrors: 1, duration: 3500, cost: 0.0123 },
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cogitator-md-html-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('markdown reporter', () => {
  it('summarizes the run for a pull request comment', () => {
    const md = markdownSummary(makeResult());

    expect(md).toContain('### Eval results: qa &lt;agent>');
    expect(md).toContain(
      '**3** cases | **1** errored | **1** metric errors | 3500 ms | 0.0123 USD | assertions: **1** passed, **1** failed'
    );
    expect(md).toContain('| exactMatch | 0.5000 | 2 |');
    expect(md).toContain(
      '| threshold(exactMatch) | **fail** | exactMatch = 0.5, expected >= 0.9 |'
    );
    expect(md).toContain('| maxErrorRate(0.5) | pass | ok |');
    expect(md).toContain('**Failed cases** (2)');
    expect(md).toContain('| [3] Timeout case | error: Timed out after 3000ms |');
    expect(md).toContain('metric exactMatch failed: judge &lt;b>broke&lt;/b>');
    expect(md).not.toContain('<script>');
  });

  it('shows the trials per case and leaves out empty sections', () => {
    const trial = makeResult().results[0];
    const md = markdownSummary(
      makeResult({
        name: undefined,
        results: [{ ...trial, trials: [trial, trial, trial] }],
        assertions: [],
        stats: { total: 1, errors: 0, duration: 10, cost: 0 },
      })
    );

    expect(md).toContain('### Eval results\n');
    expect(md).toContain('**1** cases x **3** trials | **0** errored | 10 ms | 0 USD');
    expect(md).not.toContain('assertions:');
    expect(md).not.toContain('Failed cases');
  });

  it('lists the failures of every trial', () => {
    const first = { ...makeResult().results[0], scores: [{ name: 'exactMatch', score: 1 }] };
    const second = {
      ...first,
      scores: [{ name: 'exactMatch', score: 0, error: 'judge gave no verdict' }],
    };
    const third = { ...first, output: '', error: 'Timed out', scores: [] };
    const result = makeResult({ results: [{ ...first, trials: [first, second, third] }] });

    const md = markdownSummary(result);
    const html = htmlPage(result);

    expect(md).toContain('**Failed cases** (2)');
    expect(md).toContain(
      '| [1] What is 2+2? | trial 2: metric exactMatch failed: judge gave no verdict |'
    );
    expect(md).toContain('| [1] What is 2+2? | trial 3: error: Timed out |');
    expect(html).toContain('2 of 3 trials answered');
    expect(html).toContain('trial 2: metric exactMatch failed: judge gave no verdict');
    expect(html).toContain('trial 3: error: Timed out');
  });

  it('counts the failures it does not list', () => {
    const errored = makeResult().results[2];
    const md = markdownSummary(
      makeResult({ results: Array.from({ length: MARKDOWN_MAX_FAILURES + 3 }, () => errored) })
    );

    expect(md.match(/\| error: Timed out/g)).toHaveLength(MARKDOWN_MAX_FAILURES);
    expect(md).toContain('and 3 more');
  });

  it('writes <path>.md through report()', () => {
    report(makeResult(), 'markdown', { path: join(dir, 'nested', 'eval.md') });

    const written = readFileSync(join(dir, 'nested', 'eval.md'), 'utf-8');
    expect(written).toBe(markdownSummary(makeResult()));
  });
});

describe('html reporter', () => {
  it('writes a self-contained page with every value escaped', () => {
    const html = htmlPage(makeResult());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Eval results: qa &lt;agent&gt;</title>');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/<script|<link|src="http|<img/);
    expect(html).toContain('Say &lt;script&gt;alert(1)&lt;/script&gt; | now');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('judge &lt;b&gt;broke&lt;/b&gt;');
    expect(html).toContain('<code>trace-abc</code>');
    expect(html).toContain('support v2');
    expect(html).toContain('Run <code>run-1</code>');
    expect(html).toContain('Timed out after 3000ms');
  });

  it('shows a conversation and the trials of a case', () => {
    const base = makeResult().results[0];
    const html = htmlPage(
      makeResult({
        results: [
          {
            ...base,
            turns: [
              { input: 'hi', output: 'hello' },
              { input: 'bye', output: '', error: 'boom' },
            ],
            trials: [base, { ...base, error: 'down' }],
          },
        ],
      })
    );

    expect(html).toContain('2 turns');
    expect(html).toContain('agent: (error) boom');
    expect(html).toContain('1 of 2 trials answered');
  });

  it('writes <path>.html through report(), next to the other file reports', () => {
    report(makeResult(), ['json', 'markdown', 'html'], { path: join(dir, 'eval') });

    expect(existsSync(join(dir, 'eval.json'))).toBe(true);
    expect(existsSync(join(dir, 'eval.md'))).toBe(true);
    expect(readFileSync(join(dir, 'eval.html'), 'utf-8')).toBe(htmlPage(makeResult()));
  });

  it('drops any report extension from the base path', () => {
    expect(reportPath('out/eval.html', 'md')).toBe('out/eval.md');
    expect(reportPath('out/eval.md', 'json')).toBe('out/eval.json');
    expect(reportPath(undefined, 'html')).toBe('eval-report.html');
    expect(reportPath(undefined, 'md', 'eval-comparison')).toBe('eval-comparison.md');
  });

  it('is what the suite result writes, with its name and run id', async () => {
    const result = await new EvalSuite({
      dataset: Dataset.from([{ input: 'q', expected: 'a' }]),
      target: { fn: async () => 'a' },
      metrics: [exactMatch()],
      name: 'smoke',
    }).run();

    result.report(['markdown', 'html'], { path: join(dir, 'smoke') });

    expect(readFileSync(join(dir, 'smoke.md'), 'utf-8')).toContain('### Eval results: smoke');
    expect(readFileSync(join(dir, 'smoke.html'), 'utf-8')).toContain(result.runId);
  });
});

function runComparison(): RunComparison {
  const change = (input: string, base: number, head: number) => ({
    caseKey: 'k'.repeat(64),
    input,
    base,
    head,
    delta: head - base,
  });
  return {
    base: { runId: 'run-a', name: 'qa', startedAt: '2026-10-01T00:00:00.000Z' },
    head: { runId: 'run-b', startedAt: '2026-10-02T00:00:00.000Z' },
    winner: 'head',
    metrics: {
      exactMatch: {
        base: 0.5,
        head: 0.9,
        n: 20,
        difference: 0.4,
        ci: { low: 0.2, high: 0.6 },
        effectSize: 1.1,
        test: 'mcnemar-exact',
        pValue: 0.00001,
        adjustedPValue: 0.00002,
        significant: true,
        winner: 'head',
        improved: [change('Capital of <France>?', 0, 1)],
        regressed: [change('2 | 2', 1, 0)],
      },
    },
    matched: 20,
    added: [{ caseKey: 'a'.repeat(64), input: 'new <case>' }],
    removed: [],
    warnings: ["Prompt 'support' differs: the base run used v1 (ver_1), the head run v2 (ver_2)"],
  };
}

describe('reportComparison', () => {
  it('renders a run comparison as Markdown', () => {
    const md = comparisonMarkdown(runComparison());

    expect(md).toContain('### Run comparison');
    expect(md).toContain('base qa (run-a), head run-b');
    expect(md).toContain('winner: **head** | **20** cases matched | **1** added | **0** removed');
    expect(md).toContain("- Prompt 'support' differs");
    expect(md).toContain(
      '| Metric | base | head | Difference | CI | p | Adjusted p | Significant | Winner |'
    );
    expect(md).toContain(
      '| exactMatch | 0.5000 | 0.9000 | +0.4000 | [0.2000, 0.6000] | <0.0001 | <0.0001 | **yes** | head |'
    );
    expect(md).toContain('**Regressions**');
    expect(md).toContain('| exactMatch | 2 \\| 2 | 1 | 0 | -1 |');
    expect(md).toContain('| exactMatch | Capital of &lt;France>? | 0 | 1 | +1 |');
  });

  it('lists at most 10 changes per metric in Markdown and counts the rest', () => {
    const comparison = runComparison();
    const change = comparison.metrics.exactMatch.regressed[0];
    comparison.metrics.exactMatch.regressed = Array.from({ length: 12 }, (_, i) => ({
      ...change,
      input: `case ${i}`,
    }));

    const md = comparisonMarkdown(comparison);

    expect(md.match(/\| exactMatch \| case \d+ \| 1 \| 0 \| -1 \|/g)).toHaveLength(10);
    expect(md).toContain('| case 9 |');
    expect(md).not.toContain('| case 10 |');
    expect(md).toContain('| exactMatch | and 2 more | | | |');
    expect(comparisonHtml(comparison).match(/case \d+/g)).toHaveLength(12);
  });

  it('renders a run comparison as an escaped HTML page', () => {
    const html = comparisonHtml(runComparison());

    expect(html).toContain('<title>Run comparison</title>');
    expect(html).toContain('Capital of &lt;France&gt;?');
    expect(html).toContain('new &lt;case&gt;');
    expect(html).toContain('Cases only in the head run');
    expect(html).toContain('<li class="warn">Prompt &#39;support&#39; differs');
    expect(html).not.toContain('<France>');
  });

  it('renders an EvalComparison result with the per-case changes', async () => {
    const dataset = Dataset.from([
      { input: 'one', expected: '1' },
      { input: 'two', expected: '2' },
    ]);
    const result = await new EvalComparison({
      dataset,
      targets: {
        baseline: { fn: async (input) => (input === 'one' ? '1' : 'x') },
        challenger: { fn: async (input) => (input === 'two' ? '2' : 'x') },
      },
      metrics: [exactMatch()],
      seed: 3,
    }).run();

    const md = comparisonMarkdown(result);

    expect(md).toContain('### A/B comparison');
    expect(md).toContain('winner: **tie**');
    expect(md).toContain('| Metric | baseline | challenger |');
    expect(md).toContain('| exactMatch | one | 1 | 0 | -1 |');
    expect(md).toContain('| exactMatch | two | 0 | 1 | +1 |');
    expect(md).not.toContain('Warnings');
    expect(comparisonHtml(result)).toContain('<title>A/B comparison</title>');
  });

  it('writes files at the path and prints to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportComparison(runComparison(), ['markdown', 'html', 'console'], {
        path: join(dir, 'cmp', 'diff.md'),
      });

      expect(readFileSync(join(dir, 'cmp', 'diff.md'), 'utf-8')).toBe(
        comparisonMarkdown(runComparison())
      );
      expect(readFileSync(join(dir, 'cmp', 'diff.html'), 'utf-8')).toBe(
        comparisonHtml(runComparison())
      );
      const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('Run comparison');
      expect(printed).toContain('warning');
      expect(printed).toContain('exactMatch');
      expect(printed).toContain('Regressions');
    } finally {
      log.mockRestore();
    }
  });

  it('renders a real compareRuns result', async () => {
    const run = (
      await new EvalSuite({
        dataset: Dataset.from([{ input: 'q', expected: 'a' }]),
        target: { fn: async () => 'a' },
        metrics: [exactMatch()],
      }).run()
    ).toRun();

    reportComparison(compareRuns(run, run), 'markdown', { path: join(dir, 'same') });

    const md = readFileSync(join(dir, 'same.md'), 'utf-8');
    expect(md).toContain('winner: **tie** | **1** cases matched');
    expect(md).not.toContain('Regressions');
  });
});
