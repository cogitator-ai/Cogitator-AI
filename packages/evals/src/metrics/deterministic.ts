import type { ZodType } from 'zod';
import type { MetricFn } from './types';

interface MatchOptions {
  caseSensitive?: boolean;
}

function createMetricFn(name: string, fn: MetricFn): MetricFn {
  fn.metricName = name;
  return fn;
}

export function exactMatch(opts?: MatchOptions): MetricFn {
  const caseSensitive = opts?.caseSensitive ?? false;

  return createMetricFn('exactMatch', (async (result) => {
    const expected = result.case.expected;
    if (expected === undefined) {
      return { name: 'exactMatch', score: 0, details: 'no expected value provided' };
    }

    const output = result.output.trim();
    const target = expected.trim();
    const match = caseSensitive ? output === target : output.toLowerCase() === target.toLowerCase();

    return {
      name: 'exactMatch',
      score: match ? 1 : 0,
      details: match ? undefined : `expected "${target}", got "${output}"`,
    };
  }) as MetricFn);
}

export function contains(opts?: MatchOptions): MetricFn {
  const caseSensitive = opts?.caseSensitive ?? false;

  return createMetricFn('contains', (async (result) => {
    const expected = result.case.expected;
    if (expected === undefined) {
      return { name: 'contains', score: 0, details: 'no expected value provided' };
    }

    const output = caseSensitive ? result.output : result.output.toLowerCase();
    const target = caseSensitive ? expected : expected.toLowerCase();
    const found = output.includes(target);

    return {
      name: 'contains',
      score: found ? 1 : 0,
      details: found ? undefined : `output does not contain "${expected}"`,
    };
  }) as MetricFn);
}

export function regex(pattern: string | RegExp): MetricFn {
  const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

  return createMetricFn('regex', (async (result) => {
    const match = re.test(result.output);
    return {
      name: 'regex',
      score: match ? 1 : 0,
      details: match ? undefined : `output does not match pattern ${re}`,
    };
  }) as MetricFn);
}

export function jsonSchema(schema: ZodType): MetricFn {
  return createMetricFn('jsonSchema', (async (result) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch (e) {
      return {
        name: 'jsonSchema',
        score: 0,
        details: `invalid JSON: ${(e as Error).message}`,
      };
    }

    const validation = schema.safeParse(parsed);
    if (validation.success) {
      return { name: 'jsonSchema', score: 1 };
    }

    return {
      name: 'jsonSchema',
      score: 0,
      details: `schema validation failed: ${validation.error.message}`,
    };
  }) as MetricFn);
}
