import { describe, it, expect } from 'vitest';
import { answerFormat, parseAnswer } from '@cogitator-ai/types';

describe('parseAnswer', () => {
  it('reads yes and no for a boolean, in English and Russian', () => {
    const schema = { type: 'boolean' };
    expect(parseAnswer('Yes', schema)).toEqual({ ok: true, value: true });
    expect(parseAnswer('нет', schema)).toEqual({ ok: true, value: false });
    expect(parseAnswer('maybe', schema)).toEqual({
      ok: false,
      problem: 'the answer should be yes or no',
    });
  });

  it('reads numbers within their range and enum members whatever their case', () => {
    expect(parseAnswer('3,5', { type: 'number' })).toEqual({ ok: true, value: 3.5 });
    expect(parseAnswer('9', { type: 'integer', minimum: 1, maximum: 5 })).toEqual({
      ok: false,
      problem: 'the answer should be a whole number from 1 to 5',
    });
    expect(parseAnswer('EU', { type: 'string', enum: ['eu', 'us'] })).toEqual({
      ok: true,
      value: 'eu',
    });
  });

  it('tries each member of a union and fills the one field of an object', () => {
    const union = { anyOf: [{ type: 'number' }, { type: 'boolean' }] };
    expect(parseAnswer('yes', union)).toEqual({ ok: true, value: true });
    expect(parseAnswer('7', union)).toEqual({ ok: true, value: 7 });
    const object = {
      type: 'object',
      properties: { region: { type: 'string', enum: ['eu', 'us'] } },
      required: ['region'],
    };
    expect(parseAnswer('us', object)).toEqual({ ok: true, value: { region: 'us' } });
    expect(parseAnswer('{"region":"eu"}', object)).toEqual({ ok: true, value: { region: 'eu' } });
  });

  it('takes a const only when the text names it', () => {
    const literals = { anyOf: [{ const: 'eu' }, { const: 'us' }] };
    expect(parseAnswer('us', literals)).toEqual({ ok: true, value: 'us' });
    expect(parseAnswer('EU', literals)).toEqual({ ok: true, value: 'eu' });
    expect(parseAnswer('asia', literals).ok).toBe(false);
    expect(parseAnswer('no', { const: 'DELETE' }).ok).toBe(false);
    expect(parseAnswer('delete', { const: 'DELETE' })).toEqual({ ok: true, value: 'DELETE' });
    expect(parseAnswer('yes', { const: true })).toEqual({ ok: true, value: true });
    expect(parseAnswer('no', { const: true }).ok).toBe(false);
    expect(parseAnswer('2', { const: 3 }).ok).toBe(false);
  });

  it('reads lists and keeps free text as it is', () => {
    expect(parseAnswer('a, b', { type: 'array', items: { type: 'string' } })).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
    expect(parseAnswer(' as typed ', undefined)).toEqual({ ok: true, value: ' as typed ' });
  });
});

describe('answerFormat', () => {
  it('says what an answer looks like', () => {
    expect(answerFormat({ type: 'boolean' })).toBe('yes or no');
    expect(answerFormat({ enum: ['eu', 'us'] })).toBe('one of: eu, us');
    expect(
      answerFormat({
        type: 'object',
        properties: { n: { type: 'number', minimum: 1 } },
        required: ['n'],
      })
    ).toBe('a number of at least 1');
    expect(answerFormat({ type: 'string' })).toBeUndefined();
  });
});
