import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleReport } from '../reporters/console';
import { jsonReport } from '../reporters/json';
import { csvReport } from '../reporters/csv';
import { ciReport } from '../reporters/ci';
import { report } from '../reporters';
import type { EvalSuiteResult } from '../reporters';

function makeSuiteResult(overrides?: Partial<EvalSuiteResult>): EvalSuiteResult {
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
        case: { input: 'Translate hello', expected: 'hola' },
        output: 'bonjour',
        duration: 250,
        scores: [
          { name: 'exactMatch', score: 0 },
          { name: 'relevance', score: 0.6 },
        ],
      },
    ],
    aggregated: {
      exactMatch: {
        name: 'exactMatch',
        mean: 0.5,
        median: 0.5,
        min: 0,
        max: 1,
        stdDev: 0.707,
        p50: 0.5,
        p95: 0.95,
        p99: 0.99,
      },
      relevance: {
        name: 'relevance',
        mean: 0.775,
        median: 0.775,
        min: 0.6,
        max: 0.95,
        stdDev: 0.247,
        p50: 0.775,
        p95: 0.941,
        p99: 0.948,
      },
    },
    assertions: [
      {
        name: 'exactMatch >= 0.8',
        passed: false,
        message: 'exactMatch mean 0.5 < 0.8',
        actual: 0.5,
        expected: 0.8,
      },
      {
        name: 'relevance >= 0.7',
        passed: true,
        message: 'relevance mean 0.775 >= 0.7',
        actual: 0.775,
        expected: 0.7,
      },
    ],
    stats: { total: 2, duration: 370, cost: 0.0012 },
    ...overrides,
  };
}

describe('consoleReport', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints table with metric names and values', () => {
    consoleReport(makeSuiteResult());
    const output = logs.join('\n');

    expect(output).toContain('exactMatch');
    expect(output).toContain('relevance');
    expect(output).toContain('0.5');
    expect(output).toContain('0.775');
  });

  it('prints table headers', () => {
    consoleReport(makeSuiteResult());
    const output = logs.join('\n');

    expect(output).toContain('Metric');
    expect(output).toContain('Mean');
    expect(output).toContain('Median');
    expect(output).toContain('P95');
    expect(output).toContain('Min');
    expect(output).toContain('Max');
  });

  it('shows assertion results with pass/fail indicators', () => {
    consoleReport(makeSuiteResult());
    const output = logs.join('\n');

    expect(output).toMatch(/✗.*exactMatch/);
    expect(output).toMatch(/✓.*relevance/);
  });

  it('shows summary stats', () => {
    consoleReport(makeSuiteResult());
    const output = logs.join('\n');

    expect(output).toContain('2');
    expect(output).toContain('370');
    expect(output).toContain('0.0012');
  });

  it('uses ANSI colors', () => {
    consoleReport(makeSuiteResult());
    const output = logs.join('\n');

    expect(output).toContain('\x1b[32m');
    expect(output).toContain('\x1b[31m');
    expect(output).toContain('\x1b[0m');
  });
});

describe('jsonReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'evals-json-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes valid JSON to file', () => {
    const filePath = join(tempDir, 'report.json');
    const result = makeSuiteResult();
    jsonReport(result, { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(result);
  });

  it('writes pretty-printed JSON', () => {
    const filePath = join(tempDir, 'report.json');
    jsonReport(makeSuiteResult(), { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('\n');
    expect(content).toBe(JSON.stringify(makeSuiteResult(), null, 2));
  });

  it('preserves all fields in output', () => {
    const filePath = join(tempDir, 'report.json');
    const result = makeSuiteResult();
    jsonReport(result, { path: filePath });

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.results).toHaveLength(2);
    expect(parsed.aggregated.exactMatch.mean).toBe(0.5);
    expect(parsed.assertions).toHaveLength(2);
    expect(parsed.stats.total).toBe(2);
  });
});

describe('csvReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'evals-csv-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes CSV with correct headers', () => {
    const filePath = join(tempDir, 'report.csv');
    csvReport(makeSuiteResult(), { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');

    expect(headers).toContain('input');
    expect(headers).toContain('expected');
    expect(headers).toContain('output');
    expect(headers).toContain('duration');
    expect(headers).toContain('exactMatch');
    expect(headers).toContain('relevance');
  });

  it('writes correct number of data rows', () => {
    const filePath = join(tempDir, 'report.csv');
    csvReport(makeSuiteResult(), { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('places metric scores in correct columns', () => {
    const filePath = join(tempDir, 'report.csv');
    csvReport(makeSuiteResult(), { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');
    const exactMatchIdx = headers.indexOf('exactMatch');
    const relevanceIdx = headers.indexOf('relevance');

    const row1 = lines[1].split(',');
    expect(row1[exactMatchIdx]).toBe('1');
    expect(row1[relevanceIdx]).toBe('0.95');

    const row2 = lines[2].split(',');
    expect(row2[exactMatchIdx]).toBe('0');
    expect(row2[relevanceIdx]).toBe('0.6');
  });

  it('quotes fields containing commas', () => {
    const result = makeSuiteResult();
    result.results[0].case.input = 'hello, world';
    const filePath = join(tempDir, 'report.csv');
    csvReport(result, { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('"hello, world"');
  });

  it('handles results with no scores', () => {
    const result = makeSuiteResult();
    result.results = [
      {
        case: { input: 'test' },
        output: 'out',
        duration: 50,
        scores: [],
      },
    ];
    const filePath = join(tempDir, 'report.csv');
    csvReport(result, { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('input,expected,output,duration');
  });
});

describe('ciReport', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call process.exit when all assertions pass', () => {
    const result = makeSuiteResult({
      assertions: [{ name: 'check', passed: true, message: 'ok' }],
    });
    ciReport(result);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when any assertion fails', () => {
    const result = makeSuiteResult({
      assertions: [
        { name: 'check1', passed: true, message: 'ok' },
        { name: 'check2', passed: false, message: 'failed' },
      ],
    });
    ciReport(result);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints summary to stdout', () => {
    ciReport(makeSuiteResult());
    const output = logs.join('\n');
    expect(output).toContain('2');
  });

  it('does not call process.exit with empty assertions', () => {
    const result = makeSuiteResult({ assertions: [] });
    ciReport(result);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('report() dispatcher', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to console reporter', () => {
    report(makeSuiteResult(), 'console');
    const output = logs.join('\n');
    expect(output).toContain('exactMatch');
  });

  it('delegates to json reporter', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'evals-dispatch-'));
    const filePath = join(tempDir, 'out.json');
    report(makeSuiteResult(), 'json', { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    expect(JSON.parse(content)).toHaveProperty('results');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('delegates to csv reporter', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'evals-dispatch-'));
    const filePath = join(tempDir, 'out.csv');
    report(makeSuiteResult(), 'csv', { path: filePath });

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('input,expected,output,duration');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('delegates to ci reporter', () => {
    const result = makeSuiteResult({ assertions: [{ name: 'x', passed: true, message: 'ok' }] });
    report(result, 'ci');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('runs all reporters when given an array', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'evals-multi-'));
    const jsonPath = join(tempDir, 'out.json');
    const _csvPath = join(tempDir, 'out.csv');

    const result = makeSuiteResult({ assertions: [{ name: 'x', passed: true, message: 'ok' }] });

    report(result, ['console', 'json', 'csv', 'ci'], { path: jsonPath });

    const consoleOutput = logs.join('\n');
    expect(consoleOutput).toContain('exactMatch');
    expect(() => readFileSync(jsonPath, 'utf-8')).not.toThrow();

    rmSync(tempDir, { recursive: true, force: true });
  });
});
