import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { contains, exactMatch, jsonSchema, regex } from '../metrics/deterministic';
import { metric } from '../metrics/custom';
import {
  bindJudgeContext,
  coherence,
  faithfulness,
  helpfulness,
  relevance,
} from '../metrics/llm-judge';
import type { JudgeContext } from '../metrics/llm-judge';
import type { EvalCaseResult } from '../metrics/types';
import { pairedTTest } from '../stats/t-test';
import { noRegression, threshold } from '../assertions';
import type { AggregatedMetric } from '../assertions';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import { VERSION } from '../index';

function result(output: string, expected?: string): EvalCaseResult {
  return { case: { input: 'q', expected }, output, duration: 1 };
}

function judge(output: string): JudgeContext {
  return {
    cogitator: { run: vi.fn().mockResolvedValue({ output }) },
    judgeConfig: { model: 'openai/gpt-6-luna', temperature: 0 },
  };
}

function agg(name: string, mean: number): AggregatedMetric {
  return {
    name,
    mean,
    median: mean,
    min: mean,
    max: mean,
    stdDev: 0,
    p50: mean,
    p95: mean,
    p99: mean,
  };
}

const stats = { total: 1, duration: 1, cost: 0 };

describe('regex() with a stateful flag', () => {
  it('scores the same output the same every time with /g', async () => {
    const m = regex(/\d+/g);
    const scores = [];
    for (let i = 0; i < 6; i++) scores.push((await m(result('order 42'))).score);
    expect(scores).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('scores the same output the same every time with /y', async () => {
    const m = regex(/a/y);
    const scores = [];
    for (let i = 0; i < 4; i++) scores.push((await m(result('abc'))).score);
    expect(scores).toEqual([1, 1, 1, 1]);
  });

  it('leaves the caller RegExp untouched', async () => {
    const re = /\d+/g;
    await regex(re)(result('order 42'));
    expect(re.lastIndex).toBe(0);
  });
});

describe('metric name option', () => {
  it('renames each deterministic metric', async () => {
    expect(regex(/x/, { name: 'hasX' }).metricName).toBe('hasX');
    expect((await regex(/x/, { name: 'hasX' })(result('x'))).name).toBe('hasX');
    expect((await exactMatch({ name: 'exact' })(result('a', 'a'))).name).toBe('exact');
    expect((await contains({ name: 'mentions' })(result('abc', 'b'))).name).toBe('mentions');
    expect((await jsonSchema(z.object({}), { name: 'shape' })(result('{}'))).name).toBe('shape');
  });

  it('renames each judge metric', async () => {
    for (const make of [faithfulness, relevance, coherence, helpfulness]) {
      const m = make({ name: 'renamed' });
      expect(m.metricName).toBe('renamed');
      const bound = bindJudgeContext(m, judge('{"score": 1, "reasoning": "ok"}'));
      expect((await bound(result('a'))).name).toBe('renamed');
    }
  });
});

describe('judge verdict parsing', () => {
  async function scoreOf(output: string) {
    return bindJudgeContext(faithfulness(), judge(output))(result('a'));
  }

  it('takes the labelled score, not the first number in the prose', async () => {
    expect((await scoreOf('There is 1 factual error. Score: 0.4')).score).toBe(0.4);
  });

  it('takes the last labelled score', async () => {
    expect((await scoreOf('A first score: 1 was too generous. Final score: 0.6')).score).toBe(0.6);
  });

  it('reads a fraction score', async () => {
    expect((await scoreOf('Score: 4/5')).score).toBe(0.8);
  });

  it('accepts a numeric string score in fenced JSON', async () => {
    const s = await scoreOf('```json\n{"score": "0.8", "reasoning": "good"}\n```');
    expect(s.score).toBe(0.8);
    expect(s.details).toBe('good');
    expect(s.error).toBeUndefined();
  });

  it('marks an unparseable verdict as a failed judgement', async () => {
    const s = await scoreOf('I think the answer has 1 problem.');
    expect(s.score).toBe(0);
    expect(s.error).toMatch(/could not parse judge response/);
  });

  it('marks a judge that throws as a failed judgement', async () => {
    const ctx: JudgeContext = {
      cogitator: { run: vi.fn().mockRejectedValue(new Error('rate limited')) },
      judgeConfig: { model: 'm', temperature: 0 },
    };
    const s = await bindJudgeContext(faithfulness(), ctx)(result('a'));
    expect(s.error).toBe('rate limited');
  });

  it('reports the judge usage on the score', async () => {
    const ctx: JudgeContext = {
      cogitator: {
        run: vi.fn().mockResolvedValue({
          output: '{"score": 1, "reasoning": "ok"}',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: 0.001 },
        }),
      },
      judgeConfig: { model: 'm', temperature: 0 },
    };
    const s = await bindJudgeContext(faithfulness(), ctx)(result('a'));
    expect(s.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: 0.001 });
  });
});

describe('custom metric with a score that is not finite', () => {
  it('reports NaN as a metric error', async () => {
    const m = metric({ name: 'ratio', evaluate: () => ({ score: 0 / 0 }) });
    const s = await m(result('a'));
    expect(s.score).toBe(0);
    expect(s.error).toMatch(/not a finite number/);
  });

  it('reports Infinity as a metric error instead of clamping it to 1', async () => {
    const m = metric({ name: 'ratio', evaluate: () => ({ score: 1 / 0 }) });
    const s = await m(result('a'));
    expect(s.score).toBe(0);
    expect(s.error).toMatch(/not a finite number/);
  });

  it('marks a throwing evaluate as a metric error', async () => {
    const m = metric({
      name: 'boom',
      evaluate: () => {
        throw new Error('bad input');
      },
    });
    expect((await m(result('a'))).error).toBe('bad input');
  });
});

describe('assertions on values that are not finite', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-nan-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('noRegression fails on a NaN current value', () => {
    const file = path.join(dir, 'baseline.json');
    fs.writeFileSync(file, JSON.stringify({ accuracy: 0.9 }));
    const r = noRegression(file)({ accuracy: agg('accuracy', Number.NaN) }, stats);
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/accuracy/);
  });

  it('noRegression fails on a null baseline value', () => {
    const file = path.join(dir, 'baseline.json');
    fs.writeFileSync(file, '{"accuracy": null}');
    const r = noRegression(file)({ accuracy: agg('accuracy', 0.1) }, stats);
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/accuracy/);
  });

  it('threshold says plainly that a NaN value is not a number', () => {
    const r = threshold('latency', 100)({ latency: agg('latency', Number.NaN) }, stats);
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/not a finite number/);
  });
});

describe('pairedTTest with zero variance', () => {
  it('keeps the sign of the infinite t statistic', () => {
    expect(pairedTTest([1, 1, 1], [2, 2, 2]).tStatistic).toBe(-Infinity);
    expect(pairedTTest([2, 2, 2], [1, 1, 1]).tStatistic).toBe(Infinity);
  });
});

describe('package metadata', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('EvalComparison config', () => {
  it('rejects an invalid concurrency when constructed', () => {
    expect(
      () =>
        new EvalComparison({
          dataset: Dataset.from([{ input: 'a' }]),
          targets: { baseline: { fn: async () => 'a' }, challenger: { fn: async () => 'b' } },
          concurrency: 0,
        })
    ).toThrow();
  });
});
