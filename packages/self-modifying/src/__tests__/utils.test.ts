import { describe, it, expect } from 'vitest';
import { extractJson, llmChat } from '../utils';

describe('extractJson', () => {
  it('extracts simple JSON object', () => {
    const result = extractJson('{"key": "value"}');
    expect(result).toBe('{"key": "value"}');
  });

  it('extracts JSON from surrounding text', () => {
    const result = extractJson(
      'Here is the result: {"onTrack": true, "confidence": 0.8} and that is it.'
    );
    expect(result).toBe('{"onTrack": true, "confidence": 0.8}');
  });

  it('handles nested braces', () => {
    const result = extractJson('{"a": {"b": {"c": 1}}}');
    expect(JSON.parse(result!)).toEqual({ a: { b: { c: 1 } } });
  });

  it('ignores braces inside strings', () => {
    const result = extractJson('{"text": "hello {world}"}');
    expect(JSON.parse(result!)).toEqual({ text: 'hello {world}' });
  });

  it('handles escaped quotes in strings', () => {
    const result = extractJson('{"text": "she said \\"hi\\""}');
    expect(result).toBe('{"text": "she said \\"hi\\""}');
    expect(JSON.parse(result!)).toEqual({ text: 'she said "hi"' });
  });

  it('returns null for no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJson('')).toBeNull();
  });

  it('does not greedily match across multiple JSON objects', () => {
    const input = 'Note: {not valid} But here is: {"valid": true}';
    const result = extractJson(input);
    expect(result).toBe('{not valid}');
  });

  it('handles first valid JSON from LLM response with preamble containing braces', () => {
    const input = `Here's my analysis:
{"hasGap": true, "gaps": []}`;
    const result = extractJson(input);
    expect(JSON.parse(result!)).toEqual({ hasGap: true, gaps: [] });
  });

  it('handles arrays inside objects', () => {
    const result = extractJson('{"items": [1, 2, {"nested": true}]}');
    expect(JSON.parse(result!)).toEqual({ items: [1, 2, { nested: true }] });
  });

  it('extracts JSON from markdown code blocks', () => {
    const input = 'Here is the tool:\n```json\n{"name": "calc", "implementation": "code"}\n```';
    const result = extractJson(input);
    expect(JSON.parse(result!)).toEqual({ name: 'calc', implementation: 'code' });
  });

  it('repairs unclosed JSON by adding missing braces', () => {
    const input = '{"name": "test", "value": 42';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ name: 'test', value: 42 });
  });

  it('returns null for unrepairable JSON', () => {
    const input = '{"name": "test", "bad: ';
    const result = extractJson(input);
    expect(result).toBeNull();
  });
});

describe('llmChat', () => {
  it('uses complete when available', async () => {
    const llm = {
      complete: async (_opts: { messages: unknown[] }) => ({
        content: `response from complete`,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
      chat: async () => ({
        content: 'should not be called',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };

    const result = await llmChat(llm as never, [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('response from complete');
  });

  it('falls back to chat when complete is unavailable', async () => {
    const llm = {
      chat: async (opts: { model: string }) => ({
        content: `response from chat with model ${opts.model}`,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };

    const result = await llmChat(llm as never, [{ role: 'user', content: 'hi' }], {
      model: 'gpt-4',
    });
    expect(result).toBe('response from chat with model gpt-4');
  });

  it('uses default model when none specified', async () => {
    const llm = {
      chat: async (opts: { model: string }) => ({
        content: opts.model,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };

    const result = await llmChat(llm as never, [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('default');
  });
});
