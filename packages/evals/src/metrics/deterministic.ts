import type { ZodType } from 'zod';
import type { MetricFn, MetricOptions } from './types';

interface MatchOptions extends MetricOptions {
  caseSensitive?: boolean;
}

function createMetricFn(name: string, fn: MetricFn): MetricFn {
  fn.metricName = name;
  return fn;
}

export function exactMatch(opts?: MatchOptions): MetricFn {
  const caseSensitive = opts?.caseSensitive ?? false;
  const name = opts?.name ?? 'exactMatch';

  return createMetricFn(name, (async (result) => {
    const expected = result.case.expected;
    if (expected === undefined) {
      return { name, score: 0, details: 'no expected value provided' };
    }

    const output = result.output.trim();
    const target = expected.trim();
    const match = caseSensitive ? output === target : output.toLowerCase() === target.toLowerCase();

    return {
      name,
      score: match ? 1 : 0,
      details: match ? undefined : `expected "${target}", got "${output}"`,
    };
  }) as MetricFn);
}

export function contains(opts?: MatchOptions): MetricFn {
  const caseSensitive = opts?.caseSensitive ?? false;
  const name = opts?.name ?? 'contains';

  return createMetricFn(name, (async (result) => {
    const expected = result.case.expected;
    if (expected === undefined) {
      return { name, score: 0, details: 'no expected value provided' };
    }

    const output = caseSensitive ? result.output : result.output.toLowerCase();
    const target = caseSensitive ? expected : expected.toLowerCase();
    const found = output.includes(target);

    return {
      name,
      score: found ? 1 : 0,
      details: found ? undefined : `output does not contain "${expected}"`,
    };
  }) as MetricFn);
}

/**
 * Scores 1 when the output matches `pattern`. The `g` and `y` flags are dropped: they make
 * `RegExp.test` resume from the previous match, so identical outputs would alternate between
 * pass and fail.
 */
export function regex(pattern: string | RegExp, opts?: MetricOptions): MetricFn {
  const source = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const re = new RegExp(source.source, source.flags.replace(/[gy]/g, ''));
  const name = opts?.name ?? 'regex';

  return createMetricFn(name, (async (result) => {
    const match = re.test(result.output);
    return {
      name,
      score: match ? 1 : 0,
      details: match ? undefined : `output does not match pattern ${source}`,
    };
  }) as MetricFn);
}

export function jsonSchema(schema: ZodType, opts?: MetricOptions): MetricFn {
  const name = opts?.name ?? 'jsonSchema';

  return createMetricFn(name, (async (result) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch (e) {
      return {
        name,
        score: 0,
        details: `invalid JSON: ${(e as Error).message}`,
      };
    }

    const validation = schema.safeParse(parsed);
    if (validation.success) {
      return { name, score: 1 };
    }

    return {
      name,
      score: 0,
      details: `schema validation failed: ${validation.error.message}`,
    };
  }) as MetricFn);
}
