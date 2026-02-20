import { describe, it, expect } from 'vitest';
import {
  EvalCaseSchema,
  EvalSuiteConfigSchema,
  JudgeConfigSchema,
  EvalComparisonConfigSchema,
} from '../schema';

describe('EvalCaseSchema', () => {
  it('validates minimal case with just input', () => {
    const result = EvalCaseSchema.parse({ input: 'What is 2+2?' });
    expect(result.input).toBe('What is 2+2?');
    expect(result.expected).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it('validates full case with all fields', () => {
    const result = EvalCaseSchema.parse({
      input: 'What is 2+2?',
      expected: '4',
      context: { topic: 'math', difficulty: 'easy' },
      metadata: { source: 'unit-test', version: 1 },
    });
    expect(result.input).toBe('What is 2+2?');
    expect(result.expected).toBe('4');
    expect(result.context).toEqual({ topic: 'math', difficulty: 'easy' });
    expect(result.metadata).toEqual({ source: 'unit-test', version: 1 });
  });

  it('rejects missing input', () => {
    expect(() => EvalCaseSchema.parse({})).toThrow();
    expect(() => EvalCaseSchema.parse({ expected: '4' })).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => EvalCaseSchema.parse({ input: 42 })).toThrow();
    expect(() => EvalCaseSchema.parse({ input: true })).toThrow();
    expect(() => EvalCaseSchema.parse({ input: null })).toThrow();
  });
});

describe('EvalSuiteConfigSchema', () => {
  it('applies defaults correctly', () => {
    const result = EvalSuiteConfigSchema.parse({});
    expect(result.concurrency).toBe(5);
    expect(result.timeout).toBe(30000);
    expect(result.retries).toBe(0);
  });

  it('accepts custom values', () => {
    const result = EvalSuiteConfigSchema.parse({
      concurrency: 10,
      timeout: 60000,
      retries: 3,
    });
    expect(result.concurrency).toBe(10);
    expect(result.timeout).toBe(60000);
    expect(result.retries).toBe(3);
  });

  it('rejects concurrency < 1', () => {
    expect(() => EvalSuiteConfigSchema.parse({ concurrency: 0 })).toThrow();
    expect(() => EvalSuiteConfigSchema.parse({ concurrency: -1 })).toThrow();
  });

  it('rejects timeout < 1000', () => {
    expect(() => EvalSuiteConfigSchema.parse({ timeout: 500 })).toThrow();
  });

  it('rejects retries > 10', () => {
    expect(() => EvalSuiteConfigSchema.parse({ retries: 11 })).toThrow();
  });
});

describe('JudgeConfigSchema', () => {
  it('validates with model only', () => {
    const result = JudgeConfigSchema.parse({ model: 'gpt-4o' });
    expect(result.model).toBe('gpt-4o');
    expect(result.temperature).toBe(0);
    expect(result.maxTokens).toBeUndefined();
  });

  it('applies temperature default', () => {
    const result = JudgeConfigSchema.parse({ model: 'claude-sonnet-4-20250514' });
    expect(result.temperature).toBe(0);
  });

  it('accepts all fields', () => {
    const result = JudgeConfigSchema.parse({
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 1024,
    });
    expect(result.temperature).toBe(0.5);
    expect(result.maxTokens).toBe(1024);
  });

  it('rejects missing model', () => {
    expect(() => JudgeConfigSchema.parse({})).toThrow();
  });
});

describe('EvalComparisonConfigSchema', () => {
  it('applies same defaults as EvalSuiteConfigSchema', () => {
    const result = EvalComparisonConfigSchema.parse({});
    expect(result.concurrency).toBe(5);
    expect(result.timeout).toBe(30000);
    expect(result.retries).toBe(0);
  });

  it('accepts custom values', () => {
    const result = EvalComparisonConfigSchema.parse({
      concurrency: 2,
      timeout: 15000,
      retries: 1,
    });
    expect(result.concurrency).toBe(2);
    expect(result.timeout).toBe(15000);
    expect(result.retries).toBe(1);
  });
});
