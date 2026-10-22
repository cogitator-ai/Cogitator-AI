import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const appends = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      appends.calls.push(args);
      return actual.appendFileSync(...args);
    },
  };
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubAnnotations, githubReport, githubSummary } from '../reporters/github';
import type { EvalSuiteResult } from '../reporters';

function makeResult(overrides?: Partial<EvalSuiteResult>): EvalSuiteResult {
  return {
    results: [
      {
        case: { input: 'What is 2+2?' },
        output: '4',
        duration: 120,
        scores: [
          { name: 'exactMatch', score: 1 },
          { name: 'relevance', score: 0, error: 'judge gave no verdict' },
        ],
      },
      {
        case: { input: 'Translate: hello, world' },
        output: '',
        duration: 2500,
        error: 'timed out after 2000 ms',
        scores: [],
      },
    ],
    aggregated: {
      exactMatch: {
        name: 'exactMatch',
        mean: 1,
        median: 1,
        min: 1,
        max: 1,
        stdDev: 0,
        p50: 1,
        p95: 1,
        p99: 1,
        count: 1,
      },
      relevance: {
        name: 'rel|evance',
        mean: 0.12345,
        median: 0.1,
        min: 0,
        max: 0.5,
        stdDev: 0.2,
        p50: 0.1,
        p95: 0.45,
        p99: 0.49,
      },
    },
    assertions: [
      { name: 'exactMatch >= 0.8', passed: true, message: 'exactMatch mean 1 >= 0.8' },
      { name: 'maxErrorRate(0)', passed: false, message: 'error rate 50% > 0%\nsee case 2' },
    ],
    stats: { total: 2, errors: 1, metricErrors: 1, duration: 2620, cost: 0.0012 },
    ...overrides,
  };
}

describe('githubAnnotations', () => {
  it('prints an error for each errored case and failed assertion, a warning per metric error', () => {
    expect(githubAnnotations(makeResult())).toEqual([
      '::warning title=Eval metric relevance on case [1] What is 2+2?::judge gave no verdict',
      '::error title=Eval case [2] Translate%3A hello%2C world::timed out after 2000 ms',
      '::error title=Eval assertion maxErrorRate(0)::error rate 50%25 > 0%25%0Asee case 2',
    ]);
  });

  it('escapes %, CR and LF in messages, and also : and , in properties', () => {
    const [line] = githubAnnotations(
      makeResult({
        results: [],
        assertions: [{ name: 'a:b,c%d', passed: false, message: '100%\r\ndone: yes, really' }],
      })
    );

    expect(line).toBe('::error title=Eval assertion a%3Ab%2Cc%25d::100%25%0D%0Adone: yes, really');
  });

  it('prints nothing for a clean run', () => {
    expect(
      githubAnnotations(
        makeResult({
          results: [{ case: { input: 'x' }, output: 'x', duration: 1, scores: [] }],
          assertions: [{ name: 'ok', passed: true, message: 'fine' }],
        })
      )
    ).toEqual([]);
  });
});

describe('githubSummary', () => {
  it('lists the totals, the aggregated metrics and every assertion', () => {
    const summary = githubSummary(makeResult());

    expect(summary).toContain('## Eval results');
    expect(summary).toContain(
      '**2** cases | **1** errored | **1** metric errors | 2620 ms | 0.0012 USD | assertions: **1** passed, **1** failed'
    );
    expect(summary).toContain('| Metric | Mean | P50 | P95 | Cases |');
    expect(summary).toContain('| exactMatch | 1 | 1 | 1 | 1 |');
    expect(summary).toContain('| rel\\|evance | 0.1235 | 0.1000 | 0.4500 | - |');
    expect(summary).toContain('| pass | exactMatch >= 0.8 | exactMatch mean 1 >= 0.8 |');
    expect(summary).toContain('| **fail** | maxErrorRate(0) | error rate 50% > 0%<br>see case 2 |');
  });

  it('counts the cases that carry a run flag', () => {
    const result = makeResult();
    result.results[0] = { ...result.results[0], truncated: true };

    expect(githubSummary(result)).toContain('**1** truncated, paused or at the iteration limit');
  });
});

describe('githubReport', () => {
  let tempDir: string;
  let logs: string[];
  let savedSummary: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'evals-github-'));
    logs = [];
    savedSummary = process.env.GITHUB_STEP_SUMMARY;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = savedSummary;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints the annotations and appends the summary to GITHUB_STEP_SUMMARY', () => {
    const summaryPath = join(tempDir, 'summary.md');
    writeFileSync(summaryPath, '# Earlier step\n', 'utf-8');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;

    githubReport(makeResult());

    expect(logs).toEqual(githubAnnotations(makeResult()));
    expect(readFileSync(summaryPath, 'utf-8')).toBe(
      `# Earlier step\n${githubSummary(makeResult())}`
    );
  });

  it('writes no summary when GITHUB_STEP_SUMMARY is not set', () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    appends.calls.length = 0;

    githubReport(makeResult());

    expect(logs).toHaveLength(3);
    expect(appends.calls).toEqual([]);
  });

  it('keeps every summary row whole and hides nothing an answer holds', () => {
    const summary = githubSummary(
      makeResult({
        assertions: [
          { name: 'a|b', passed: false, message: 'line one\rline two\r\nthree <!-- hide & seek' },
        ],
      })
    );

    const row = summary.split('\n').find((line) => line.includes('a\\|b'));
    expect(row).toContain('line one<br>line two<br>three &lt;!-- hide &amp; seek');
    expect(summary).not.toContain('<!--');
  });
});
