import { describe, it, expect } from 'vitest';
import { latency, cost, tokenUsage } from '../metrics/statistical';
import type { EvalCaseResult } from '../metrics/types';

function makeResult(duration: number, usage?: EvalCaseResult['usage']): EvalCaseResult {
  return {
    case: { input: 'test' },
    output: 'output',
    duration,
    usage,
  };
}

describe('latency', () => {
  it('aggregates durations with p50/p95/p99', () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const results = durations.map((d) => makeResult(d));
    const score = latency()(results);

    expect(score.name).toBe('latency');
    expect(score.score).toBe(0);
    expect(score.metadata).toBeDefined();

    const meta = score.metadata as Record<string, number>;
    expect(meta.mean).toBe(550);
    expect(meta.median).toBe(550);
    expect(meta.p50).toBe(550);
    expect(meta.min).toBe(100);
    expect(meta.max).toBe(1000);
    expect(meta.p95).toBeCloseTo(955, 0);
    expect(meta.p99).toBeCloseTo(991, 0);
  });

  it('returns all zeros for empty results', () => {
    const score = latency()([]);

    expect(score.score).toBe(0);
    const meta = score.metadata as Record<string, number>;
    expect(meta.p50).toBe(0);
    expect(meta.p95).toBe(0);
    expect(meta.p99).toBe(0);
    expect(meta.mean).toBe(0);
    expect(meta.median).toBe(0);
    expect(meta.min).toBe(0);
    expect(meta.max).toBe(0);
  });

  it('has correct metricName', () => {
    expect(latency().metricName).toBe('latency');
  });
});

describe('cost', () => {
  it('aggregates cost from results with usage', () => {
    const results = [
      makeResult(100, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cost: 0.01,
        duration: 90,
      }),
      makeResult(200, {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cost: 0.02,
        duration: 180,
      }),
      makeResult(300, {
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
        cost: 0.03,
        duration: 270,
      }),
    ];
    const score = cost()(results);

    expect(score.name).toBe('cost');
    expect(score.score).toBe(0);

    const meta = score.metadata as Record<string, number>;
    expect(meta.total).toBeCloseTo(0.06, 10);
    expect(meta.mean).toBeCloseTo(0.02, 10);
    expect(meta.median).toBeCloseTo(0.02, 10);
    expect(meta.min).toBeCloseTo(0.01, 10);
    expect(meta.max).toBeCloseTo(0.03, 10);
  });

  it('returns zeros when no results have usage', () => {
    const results = [makeResult(100), makeResult(200)];
    const score = cost()(results);

    const meta = score.metadata as Record<string, number>;
    expect(meta.total).toBe(0);
    expect(meta.mean).toBe(0);
    expect(meta.median).toBe(0);
    expect(meta.min).toBe(0);
    expect(meta.max).toBe(0);
  });

  it('handles mixed results (some with, some without usage)', () => {
    const results = [
      makeResult(100, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cost: 0.01,
        duration: 90,
      }),
      makeResult(200),
      makeResult(300, {
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
        cost: 0.03,
        duration: 270,
      }),
    ];
    const score = cost()(results);

    const meta = score.metadata as Record<string, number>;
    expect(meta.total).toBeCloseTo(0.04, 10);
    expect(meta.mean).toBeCloseTo(0.02, 10);
    expect(meta.min).toBeCloseTo(0.01, 10);
    expect(meta.max).toBeCloseTo(0.03, 10);
  });

  it('has correct metricName', () => {
    expect(cost().metricName).toBe('cost');
  });
});

describe('tokenUsage', () => {
  it('aggregates token counts from results with usage', () => {
    const results = [
      makeResult(100, {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.01,
        duration: 90,
      }),
      makeResult(200, {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.02,
        duration: 180,
      }),
      makeResult(300, {
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
        cost: 0.03,
        duration: 270,
      }),
    ];
    const score = tokenUsage()(results);

    expect(score.name).toBe('tokenUsage');
    expect(score.score).toBe(0);

    const meta = score.metadata as Record<string, number>;
    expect(meta.totalInput).toBe(600);
    expect(meta.totalOutput).toBe(300);
    expect(meta.totalTokens).toBe(900);
    expect(meta.meanInput).toBe(200);
    expect(meta.meanOutput).toBe(100);
  });

  it('returns zeros when no results have usage', () => {
    const results = [makeResult(100), makeResult(200)];
    const score = tokenUsage()(results);

    const meta = score.metadata as Record<string, number>;
    expect(meta.totalInput).toBe(0);
    expect(meta.totalOutput).toBe(0);
    expect(meta.totalTokens).toBe(0);
    expect(meta.meanInput).toBe(0);
    expect(meta.meanOutput).toBe(0);
  });

  it('has correct metricName', () => {
    expect(tokenUsage().metricName).toBe('tokenUsage');
  });
});
