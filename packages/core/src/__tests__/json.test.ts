import { describe, it, expect } from 'vitest';
import { jsonParse, jsonStringify } from '../tools/json.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('jsonParse tool', () => {
  it('parses valid JSON object', async () => {
    const result = await jsonParse.execute({ json: '{"name": "test", "value": 42}' }, mockContext);
    expect(result).toHaveProperty('valid', true);
    expect(result).toHaveProperty('result');
    expect((result as { result: object }).result).toEqual({ name: 'test', value: 42 });
  });

  it('parses valid JSON array', async () => {
    const result = await jsonParse.execute({ json: '[1, 2, 3]' }, mockContext);
    expect((result as { result: number[] }).result).toEqual([1, 2, 3]);
  });

  it('parses JSON primitives', async () => {
    expect((await jsonParse.execute({ json: '"hello"' }, mockContext) as { result: string }).result).toBe('hello');
    expect((await jsonParse.execute({ json: '42' }, mockContext) as { result: number }).result).toBe(42);
    expect((await jsonParse.execute({ json: 'true' }, mockContext) as { result: boolean }).result).toBe(true);
    expect((await jsonParse.execute({ json: 'null' }, mockContext) as { result: null }).result).toBe(null);
  });

  it('returns error for invalid JSON', async () => {
    const result = await jsonParse.execute({ json: '{invalid}' }, mockContext);
    expect(result).toHaveProperty('valid', false);
    expect(result).toHaveProperty('error');
  });

  it('returns error for incomplete JSON', async () => {
    const result = await jsonParse.execute({ json: '{"unclosed": ' }, mockContext);
    expect(result).toHaveProperty('valid', false);
  });

  it('has correct metadata', () => {
    expect(jsonParse.name).toBe('json_parse');
  });
});

describe('jsonStringify tool', () => {
  it('stringifies object', async () => {
    const result = await jsonStringify.execute({ data: { a: 1, b: 2 } }, mockContext);
    expect((result as { result: string }).result).toBe('{"a":1,"b":2}');
    expect(result).toHaveProperty('pretty', false);
  });

  it('stringifies with pretty formatting', async () => {
    const result = await jsonStringify.execute({ data: { a: 1 }, pretty: true }, mockContext);
    expect((result as { result: string }).result).toBe('{\n  "a": 1\n}');
  });

  it('respects custom indent', async () => {
    const result = await jsonStringify.execute({ data: { a: 1 }, pretty: true, indent: 4 }, mockContext);
    expect((result as { result: string }).result).toBe('{\n    "a": 1\n}');
  });

  it('stringifies arrays', async () => {
    const result = await jsonStringify.execute({ data: [1, 2, 3] }, mockContext);
    expect((result as { result: string }).result).toBe('[1,2,3]');
  });

  it('stringifies primitives', async () => {
    expect((await jsonStringify.execute({ data: 'hello' }, mockContext) as { result: string }).result).toBe('"hello"');
    expect((await jsonStringify.execute({ data: 42 }, mockContext) as { result: string }).result).toBe('42');
    expect((await jsonStringify.execute({ data: null }, mockContext) as { result: string }).result).toBe('null');
  });

  it('has correct metadata', () => {
    expect(jsonStringify.name).toBe('json_stringify');
  });
});
