import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvals } from '../commands/eval.js';
import { findEvalFiles, isEvalSuite, missingCredential, suitePassed } from '../utils/evals.js';

const dirs: string[] = [];
let cwd: string;

afterEach(() => {
  if (cwd) process.chdir(cwd);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A project whose evals/ holds suites with the given assertion outcomes, as plain ES modules. */
function project(suites: Record<string, boolean[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-eval-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'evals', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(dir, 'cogitator.yml'),
    'llm:\n  defaultProvider: openai\n  defaultModel: openai/gpt-6.1-sol\n'
  );
  for (const [name, outcomes] of Object.entries(suites)) {
    const assertions = outcomes.map((passed, i) => ({
      name: `a${i}`,
      passed,
      message: passed ? 'ok' : 'too low',
    }));
    writeFileSync(
      join(dir, 'evals', name),
      `export default {
        async run() {
          return {
            assertions: ${JSON.stringify(assertions)},
            aggregated: { contains: { name: 'contains', mean: 0.9 } },
            stats: { total: 4, errors: 0, duration: 10, cost: 0.001 },
            report() {},
          };
        },
      };\n`
    );
  }
  cwd = process.cwd();
  process.chdir(dir);
  return dir;
}

describe('eval files', () => {
  it('finds *.eval files recursively in a stable order', () => {
    const dir = project({ 'b.eval.mjs': [true], 'nested/a.eval.mjs': [true] });
    writeFileSync(join(dir, 'evals', 'helper.mjs'), '');
    expect(findEvalFiles(join(dir, 'evals')).map((f) => f.slice(dir.length + 1))).toEqual([
      'evals/b.eval.mjs',
      'evals/nested/a.eval.mjs',
    ]);
  });

  it('recognizes a suite by its run method', () => {
    expect(isEvalSuite({ run: async () => undefined })).toBe(true);
    expect(isEvalSuite({ cases: [] })).toBe(false);
  });

  it('fails a suite whose assertions fail or whose every case errored', () => {
    const base = { aggregated: {}, report: () => undefined };
    expect(
      suitePassed({ ...base, assertions: [], stats: { total: 2, errors: 2, duration: 0, cost: 0 } })
    ).toBe(false);
    expect(
      suitePassed({
        ...base,
        assertions: [{ name: 'x', passed: true, message: '' }],
        stats: { total: 2, errors: 1, duration: 0, cost: 0 },
      })
    ).toBe(true);
  });
});

describe('cogitator eval', () => {
  it('passes when every suite holds and reports them as JSON', async () => {
    project({ 'a.eval.mjs': [true, true] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runEvals([], { json: true })).toBe(0);

    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      suites: Array<{ file: string; passed: boolean; metrics: Record<string, number> }>;
    };
    expect(output.ok).toBe(true);
    expect(output.suites).toEqual([
      expect.objectContaining({
        file: join('evals', 'a.eval.mjs'),
        passed: true,
        metrics: { contains: 0.9 },
      }),
    ]);
  });

  it('exits 1 when an assertion fails', async () => {
    project({ 'a.eval.mjs': [true], 'b.eval.mjs': [false] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runEvals([], {})).toBe(1);
  });

  it('runs only the files it is given', async () => {
    project({ 'a.eval.mjs': [false], 'b.eval.mjs': [true] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runEvals(['evals/b.eval.mjs'], {})).toBe(0);
  });

  it('skips without the model key when asked to', async () => {
    project({ 'a.eval.mjs': [false] });
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('COGITATOR_OPENAI_API_KEY', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runEvals([], { skipWithoutKey: true })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('Skipping evals: OPENAI_API_KEY is not set');
  });

  it('refuses a project without eval files', async () => {
    project({});
    await expect(runEvals([], {})).rejects.toThrow('No eval files found');
  });
});

describe('missingCredential', () => {
  it('names the variable the default model needs', () => {
    expect(missingCredential({ llm: { defaultModel: 'anthropic/claude-sonnet-5-5' } })).toBe(
      'ANTHROPIC_API_KEY'
    );
    expect(
      missingCredential({
        llm: {
          defaultModel: 'anthropic/claude-sonnet-5-5',
          providers: { anthropic: { apiKey: 'k' } },
        },
      })
    ).toBeUndefined();
    expect(missingCredential({ llm: { defaultModel: 'ollama/qwen3.5:9b' } })).toBeUndefined();
  });
});
