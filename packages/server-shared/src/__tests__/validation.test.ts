import { describe, it, expect } from 'vitest';
import {
  MAX_RUN_TIMEOUT_MS,
  NON_BLANK_PATTERN,
  isNonBlankString,
  parseResumeRequest,
  parseRunRequest,
  runRequestRunOptions,
  parseSwarmRunRequest,
  toRunUsage,
} from '../index';

describe('parseRunRequest', () => {
  it.each([
    ['an empty input', { input: '' }, 'Field "input" must not be blank'],
    ['a whitespace-only input', { input: ' \t\n ' }, 'Field "input" must not be blank'],
    ['a missing input', {}, 'Missing required field: input'],
    ['a null input', { input: null }, 'Missing required field: input'],
    ['no body', undefined, 'Missing required field: input'],
    ['a numeric input', { input: 42 }, 'Field "input" must be a string'],
    ['an array context', { input: 'hi', context: [] }, 'Field "context" must be an object'],
    [
      'a numeric threadId',
      { input: 'hi', threadId: 7 },
      'Field "threadId" must be a non-empty string',
    ],
    [
      'a blank threadId',
      { input: 'hi', threadId: '  ' },
      'Field "threadId" must be a non-empty string',
    ],
  ])('refuses %s', (_name, body, message) => {
    expect(parseRunRequest(body)).toEqual({ ok: false, message });
  });

  it('keeps the input as sent, surrounding whitespace included', () => {
    expect(
      parseRunRequest(
        { input: '  hi  ', context: { a: 1 }, threadId: 't-1' },
        { acceptContext: ['a'] }
      )
    ).toEqual({
      ok: true,
      value: { input: '  hi  ', context: { a: 1 }, threadId: 't-1' },
    });
  });

  it('leaves out optional fields that were not sent', () => {
    expect(parseRunRequest({ input: 'hi' })).toEqual({ ok: true, value: { input: 'hi' } });
  });
});

describe('parseSwarmRunRequest', () => {
  it('refuses a whitespace-only input before looking at the timeout', () => {
    expect(parseSwarmRunRequest({ input: '   ', timeout: 1000 })).toEqual({
      ok: false,
      message: 'Field "input" must not be blank',
    });
  });

  it.each([0, -1, Number.NaN, '5'])('refuses the timeout %j', (timeout) => {
    expect(parseSwarmRunRequest({ input: 'go', timeout })).toEqual({
      ok: false,
      message: 'Field "timeout" must be a positive number',
    });
  });

  it('accepts a positive timeout', () => {
    expect(parseSwarmRunRequest({ input: 'go', timeout: 500 })).toEqual({
      ok: true,
      value: { input: 'go', timeout: 500 },
    });
  });

  it('accepts the longest timeout a timer can hold', () => {
    expect(parseSwarmRunRequest({ input: 'go', timeout: MAX_RUN_TIMEOUT_MS })).toEqual({
      ok: true,
      value: { input: 'go', timeout: MAX_RUN_TIMEOUT_MS },
    });
  });

  it('refuses a timeout a timer would overflow and fire at once', () => {
    expect(parseSwarmRunRequest({ input: 'go', timeout: MAX_RUN_TIMEOUT_MS + 1 })).toEqual({
      ok: false,
      message: `Field "timeout" must be at most ${MAX_RUN_TIMEOUT_MS} ms`,
    });
  });
});

describe('NON_BLANK_PATTERN', () => {
  it('matches what isNonBlankString accepts', () => {
    const pattern = new RegExp(NON_BLANK_PATTERN);
    for (const value of ['', ' ', '\t\n', ' a ', 'x']) {
      expect(pattern.test(value)).toBe(isNonBlankString(value));
    }
  });
});

describe('toRunUsage', () => {
  it('keeps the provider counts the model reported and drops cost and duration', () => {
    expect(
      toRunUsage({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        reasoningTokens: 8,
        cachedInputTokens: 4,
        cacheWriteTokens: 2,
        cost: 0.1,
        duration: 50,
      } as Parameters<typeof toRunUsage>[0])
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      reasoningTokens: 8,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
  });

  it('leaves out counts the model did not report', () => {
    expect(Object.keys(toRunUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }))).toEqual([
      'inputTokens',
      'outputTokens',
      'totalTokens',
    ]);
  });
});

describe('double-texting and interrupt answers in requests', () => {
  it('reads a multitask strategy and refuses an unknown one', () => {
    const parsed = parseRunRequest({ input: 'hi', multitaskStrategy: 'rollback' });
    expect(parsed).toEqual({ ok: true, value: { input: 'hi', multitaskStrategy: 'rollback' } });
    expect(parsed.ok && runRequestRunOptions(parsed.value)).toEqual({
      multitaskStrategy: 'rollback',
    });
    expect(runRequestRunOptions({})).toEqual({});
    expect(parseRunRequest({ input: 'hi', multitaskStrategy: 'later' })).toEqual({
      ok: false,
      message: 'Field "multitaskStrategy" must be one of enqueue, reject, interrupt, rollback',
    });
  });

  it('reads the answers of a resume and refuses answers that are not an object', () => {
    expect(parseResumeRequest({ threadId: 't', responses: { 'c1#0': { ok: true } } })).toEqual({
      ok: true,
      value: { threadId: 't', responses: { 'c1#0': { ok: true } } },
    });
    expect(parseResumeRequest({ threadId: 't', responses: ['yes'] })).toEqual({
      ok: false,
      message: 'Field "responses" must be an object',
    });
  });
});
