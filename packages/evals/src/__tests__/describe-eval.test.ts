import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface AssertionReport {
  fullName: string;
  status: string;
  failureMessages: string[];
}

interface JsonReport {
  numTotalTests: number;
  testResults: Array<{ assertionResults: AssertionReport[] }>;
}

const fixtureConfig = join(import.meta.dirname, 'fixtures', 'describe-eval', 'vitest.config.ts');
const vitestBin = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'TEST')
  );
}

function runFixture(outputFile: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        'run',
        '--config',
        fixtureConfig,
        '--reporter=json',
        `--outputFile=${outputFile}`,
      ],
      { cwd: dirname(fixtureConfig), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('describeEval in a real vitest run', () => {
  let tempDir: string;
  let exitCode: number | null;
  let tests: Map<string, AssertionReport>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'evals-describe-'));
    const outputFile = join(tempDir, 'report.json');
    const { code, output } = await runFixture(outputFile);
    exitCode = code;

    let report: JsonReport;
    try {
      report = JSON.parse(readFileSync(outputFile, 'utf-8')) as JsonReport;
    } catch (error) {
      throw new Error(`The nested vitest run wrote no report:\n${output}`, { cause: error });
    }
    tests = new Map(
      report.testResults.flatMap((file) => file.assertionResults).map((t) => [t.fullName, t])
    );
  }, 120_000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function test(fullName: string): AssertionReport {
    const found = tests.get(fullName);
    if (!found) throw new Error(`No test '${fullName}' in ${[...tests.keys()].join(', ')}`);
    return found;
  }

  function failure(fullName: string): string {
    const t = test(fullName);
    expect(t.status).toBe('failed');
    return t.failureMessages.join('\n');
  }

  it('fails the run as a whole when a case or an assertion failed', () => {
    expect(exitCode).toBe(1);
  });

  it('registers a test per case up to maxCases, plus an assertions test', () => {
    const passing = [...tests.keys()].filter((name) => name.startsWith('passing '));

    expect(passing).toEqual(['passing [1] 2+2', 'passing [2] 3+3', 'passing assertions']);
    for (const name of passing) expect(test(name).status).toBe('passed');
  });

  it('fails the test of an errored case with its error, and passes the others', () => {
    expect(test('failing case [1] 2+2').status).toBe('passed');
    expect(test('failing case [3] 5+5').status).toBe('passed');
    expect(failure('failing case [2] unknown input')).toContain(
      'Case failed after 1 attempt(s): no answer for unknown\ninput'
    );
  });

  it('fails the assertions test with every failed assertion', () => {
    expect(failure('failing case assertions')).toContain(
      '1 assertion(s) failed:\n  threshold(exactMatch): exactMatch = 0.5'
    );
  });

  it('fails every test with the cause when the suite run itself failed', () => {
    for (const name of ['run failure [1] 2+2', 'run failure [2] 3+3', 'run failure assertions']) {
      const message = failure(name);
      expect(message).toContain("Eval suite 'run failure' failed to run: cancelled before start");
      expect(message).not.toMatch(/cannot read propert/i);
    }
  });

  it('cancels a run that outlives its timeout and fails the tests with it', () => {
    for (const name of ['timeout [1] 2+2', 'timeout assertions']) {
      expect(failure(name)).toContain(
        "Eval suite 'timeout' failed to run: the run did not finish within 300 ms"
      );
    }
  });

  it('gives later tests the finished result', () => {
    expect(test('result access reads the finished result').status).toBe('passed');
  });
});
