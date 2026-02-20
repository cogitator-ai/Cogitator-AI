import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { exactMatch, contains, regex, jsonSchema } from '../metrics/deterministic';
import type { EvalCaseResult } from '../metrics/types';

function makeResult(output: string, expected?: string): EvalCaseResult {
  return {
    case: { input: 'test', expected },
    output,
    duration: 100,
  };
}

describe('exactMatch', () => {
  it('scores 1 when output matches expected', async () => {
    const metric = exactMatch();
    const score = await metric(makeResult('hello', 'hello'));
    expect(score).toEqual({ name: 'exactMatch', score: 1 });
  });

  it('scores 0 when output does not match', async () => {
    const score = await exactMatch()(makeResult('hello', 'world'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('expected "world"');
  });

  it('is case-insensitive by default', async () => {
    const score = await exactMatch()(makeResult('Hello World', 'hello world'));
    expect(score.score).toBe(1);
  });

  it('respects caseSensitive option', async () => {
    const metric = exactMatch({ caseSensitive: true });
    expect((await metric(makeResult('Hello', 'hello'))).score).toBe(0);
    expect((await metric(makeResult('Hello', 'Hello'))).score).toBe(1);
  });

  it('trims whitespace before comparing', async () => {
    const score = await exactMatch()(makeResult('  hello  ', 'hello'));
    expect(score.score).toBe(1);
  });

  it('scores 0 with details when expected is undefined', async () => {
    const score = await exactMatch()(makeResult('hello'));
    expect(score.score).toBe(0);
    expect(score.details).toBe('no expected value provided');
  });

  it('handles empty strings', async () => {
    const score = await exactMatch()(makeResult('', ''));
    expect(score.score).toBe(1);
  });

  it('has metricName property', () => {
    expect(exactMatch().metricName).toBe('exactMatch');
  });
});

describe('contains', () => {
  it('scores 1 when output contains expected', async () => {
    const score = await contains()(makeResult('the answer is 42', '42'));
    expect(score.score).toBe(1);
  });

  it('scores 0 when output does not contain expected', async () => {
    const score = await contains()(makeResult('no match here', 'missing'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('does not contain');
  });

  it('is case-insensitive by default', async () => {
    const score = await contains()(makeResult('Hello World', 'hello'));
    expect(score.score).toBe(1);
  });

  it('respects caseSensitive option', async () => {
    const metric = contains({ caseSensitive: true });
    expect((await metric(makeResult('Hello World', 'hello'))).score).toBe(0);
    expect((await metric(makeResult('Hello World', 'Hello'))).score).toBe(1);
  });

  it('scores 0 with details when expected is undefined', async () => {
    const score = await contains()(makeResult('hello'));
    expect(score.score).toBe(0);
    expect(score.details).toBe('no expected value provided');
  });

  it('handles empty substring', async () => {
    const score = await contains()(makeResult('anything', ''));
    expect(score.score).toBe(1);
  });

  it('handles multiline output', async () => {
    const score = await contains()(makeResult('line one\nline two\nline three', 'line two'));
    expect(score.score).toBe(1);
  });

  it('has metricName property', () => {
    expect(contains().metricName).toBe('contains');
  });
});

describe('regex', () => {
  it('scores 1 when output matches pattern', async () => {
    const score = await regex('\\d+')(makeResult('answer is 42'));
    expect(score.score).toBe(1);
  });

  it('scores 0 when output does not match', async () => {
    const score = await regex('^\\d+$')(makeResult('not a number'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('does not match');
  });

  it('accepts RegExp object', async () => {
    const score = await regex(/^yes$/i)(makeResult('Yes'));
    expect(score.score).toBe(1);
  });

  it('accepts string pattern', async () => {
    const score = await regex('^[a-z]+$')(makeResult('hello'));
    expect(score.score).toBe(1);
  });

  it('handles multiline output', async () => {
    const score = await regex(/second/)(makeResult('first\nsecond\nthird'));
    expect(score.score).toBe(1);
  });

  it('has metricName property', () => {
    expect(regex('.*').metricName).toBe('regex');
  });
});

describe('jsonSchema', () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it('scores 1 when output is valid JSON matching schema', async () => {
    const score = await jsonSchema(schema)(makeResult('{"name": "Alice", "age": 30}'));
    expect(score.score).toBe(1);
  });

  it('scores 0 when JSON does not match schema', async () => {
    const score = await jsonSchema(schema)(makeResult('{"name": "Alice", "age": "thirty"}'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('schema validation failed');
  });

  it('scores 0 when output is not valid JSON', async () => {
    const score = await jsonSchema(schema)(makeResult('not json'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('invalid JSON');
  });

  it('scores 0 when JSON is missing required fields', async () => {
    const score = await jsonSchema(schema)(makeResult('{"name": "Alice"}'));
    expect(score.score).toBe(0);
    expect(score.details).toContain('schema validation failed');
  });

  it('handles empty object against strict schema', async () => {
    const score = await jsonSchema(schema)(makeResult('{}'));
    expect(score.score).toBe(0);
  });

  it('has metricName property', () => {
    expect(jsonSchema(schema).metricName).toBe('jsonSchema');
  });
});
