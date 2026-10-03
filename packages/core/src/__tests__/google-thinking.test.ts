import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleBackend, geminiThinkingConfig } from '../llm/google';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const thinkingResponse = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Multiply 17 by 23.', thought: true }, { text: '391' }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 15,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 192,
    cachedContentTokenCount: 8,
    totalTokenCount: 210,
  },
};

function streamBody(lines: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < lines.length
          ? { done: false, value: encoder.encode(lines[index++]) }
          : { done: true, value: undefined },
      releaseLock: () => undefined,
    }),
  };
}

const sentBody = () =>
  JSON.parse((mockFetch.mock.calls.at(-1) as [string, RequestInit])[1].body as string) as {
    generationConfig?: { thinkingConfig?: unknown };
  };

describe('Gemini thinking', () => {
  let backend: GoogleBackend;

  beforeEach(() => {
    backend = new GoogleBackend({ apiKey: 'k' });
    mockFetch.mockReset();
  });

  it.each([
    [
      'gemini-3.5-flash-lite',
      { effort: 'medium', summary: true },
      { thinkingLevel: 'medium', includeThoughts: true },
    ],
    ['gemini-3-pro', { effort: 'max' }, { thinkingLevel: 'high' }],
    ['gemini-3-flash', { effort: 'none' }, { thinkingLevel: 'minimal' }],
    ['gemini-2.5-flash', { effort: 'none' }, { thinkingBudget: 0 }],
    ['gemini-2.5-pro', { effort: 'none' }, { thinkingBudget: 128 }],
    [
      'gemini-2.5-flash',
      { budgetTokens: 2000, summary: true },
      { thinkingBudget: 2000, includeThoughts: true },
    ],
    ['gemini-2.0-flash', { effort: 'high' }, undefined],
  ] as const)('%s with %j', (model, reasoning, expected) => {
    expect(geminiThinkingConfig(model, reasoning)).toEqual(expected);
  });

  it('sends the thinking config and returns thoughts as reasoning', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => thinkingResponse });

    const response = await backend.chat({
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: '17*23?' }],
      reasoning: { effort: 'medium', summary: true },
    });

    expect(sentBody().generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: 'medium',
      includeThoughts: true,
    });
    expect(response.content).toBe('391');
    expect(response.reasoning).toBe('Multiply 17 by 23.');
  });

  it('bills thinking tokens as output', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => thinkingResponse });

    const response = await backend.chat({
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: '17*23?' }],
    });

    expect(response.usage).toEqual({
      inputTokens: 15,
      outputTokens: 195,
      totalTokens: 210,
      cachedInputTokens: 8,
      reasoningTokens: 192,
    });
  });

  it('streams thoughts as reasoning deltas', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: streamBody([
        'data: {"candidates":[{"content":{"parts":[{"text":"Thinking it over.","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"391"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":3,"thoughtsTokenCount":40,"totalTokenCount":58}}\n\n',
      ]),
    });

    const chunks = [];
    for await (const chunk of backend.chatStream({
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: '17*23?' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta.reasoning).filter(Boolean)).toEqual(['Thinking it over.']);
    expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(['391']);
    expect(chunks.at(-1)?.usage).toMatchObject({ outputTokens: 43, reasoningTokens: 40 });
  });
});
