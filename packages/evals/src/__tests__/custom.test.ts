import { describe, it, expect } from 'vitest';
import { metric } from '../metrics/custom';
import type { EvalCaseResult } from '../metrics/types';

function makeResult(
  input: string,
  output: string,
  expected?: string,
  context?: Record<string, unknown>
): EvalCaseResult {
  return {
    case: { input, expected, context },
    output,
    duration: 100,
  };
}

describe('metric (custom)', () => {
  it('returns score correctly from sync evaluate', async () => {
    const m = metric({
      name: 'myMetric',
      evaluate: () => ({ score: 0.75 }),
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result).toEqual({ name: 'myMetric', score: 0.75 });
  });

  it('returns score correctly from async evaluate', async () => {
    const m = metric({
      name: 'asyncMetric',
      evaluate: async () => ({ score: 0.5, details: 'async works' }),
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result).toEqual({ name: 'asyncMetric', score: 0.5, details: 'async works' });
  });

  it('clamps score above 1 to 1', async () => {
    const m = metric({
      name: 'overScore',
      evaluate: () => ({ score: 1.5 }),
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result.score).toBe(1);
  });

  it('clamps score below 0 to 0', async () => {
    const m = metric({
      name: 'underScore',
      evaluate: () => ({ score: -0.3 }),
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result.score).toBe(0);
  });

  it('returns score 0 with error details when evaluate throws', async () => {
    const m = metric({
      name: 'errorMetric',
      evaluate: () => {
        throw new Error('something broke');
      },
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result.score).toBe(0);
    expect(result.details).toContain('something broke');
  });

  it('returns score 0 with error details when async evaluate rejects', async () => {
    const m = metric({
      name: 'asyncError',
      evaluate: async () => {
        throw new Error('async failure');
      },
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result.score).toBe(0);
    expect(result.details).toContain('async failure');
  });

  it('passes details through', async () => {
    const m = metric({
      name: 'detailed',
      evaluate: () => ({ score: 0.8, details: 'looks good' }),
    });

    const result = await m(makeResult('hi', 'hello'));
    expect(result.details).toBe('looks good');
  });

  it('sets metricName property', () => {
    const m = metric({
      name: 'namedMetric',
      evaluate: () => ({ score: 1 }),
    });

    expect(m.metricName).toBe('namedMetric');
  });

  it('passes all fields to evaluate', async () => {
    let captured: {
      input: string;
      output: string;
      expected?: string;
      context?: Record<string, unknown>;
    } | null = null;

    const m = metric({
      name: 'captureMetric',
      evaluate: (data) => {
        captured = data;
        return { score: 1 };
      },
    });

    await m(makeResult('my input', 'my output', 'my expected', { key: 'value' }));

    expect(captured).toEqual({
      input: 'my input',
      output: 'my output',
      expected: 'my expected',
      context: { key: 'value' },
    });
  });

  it('passes undefined expected and context when not provided', async () => {
    let captured: Record<string, unknown> | null = null;

    const m = metric({
      name: 'sparseMetric',
      evaluate: (data) => {
        captured = data as unknown as Record<string, unknown>;
        return { score: 1 };
      },
    });

    await m(makeResult('input', 'output'));

    expect(captured).toEqual({
      input: 'input',
      output: 'output',
      expected: undefined,
      context: undefined,
    });
  });
});
