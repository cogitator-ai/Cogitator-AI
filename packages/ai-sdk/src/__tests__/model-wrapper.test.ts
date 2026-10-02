import { describe, it, expect, vi } from 'vitest';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { ChatRequest, ChatStreamChunk, Message } from '@cogitator-ai/types';
import { fromAISDK, AISDKBackend } from '../model-wrapper';
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from '../v1-types';
import { collectAsync } from './helpers';

function streamOf<T>(parts: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'test-model', messages: [{ role: 'user', content: 'test' }], ...overrides };
}

function v1Model(overrides: Partial<LanguageModelV1> = {}) {
  const doGenerate = vi.fn(async (_options: LanguageModelV1CallOptions) => ({
    text: 'v1 response',
    finishReason: 'stop' as const,
    usage: { promptTokens: 5, completionTokens: 10 },
    rawCall: { rawPrompt: '', rawSettings: {} },
  }));
  const doStream = vi.fn(async (_options: LanguageModelV1CallOptions) => ({
    stream: streamOf<LanguageModelV1StreamPart>([
      { type: 'text-delta', textDelta: 'hel' },
      { type: 'text-delta', textDelta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 7 } },
    ]),
    rawCall: { rawPrompt: '', rawSettings: {} },
  }));
  const model: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: 'mock.v1',
    modelId: 'mock-v1',
    defaultObjectGenerationMode: 'json',
    doGenerate,
    doStream,
    ...overrides,
  };
  return { model, doGenerate, doStream };
}

function v2Model(
  content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'] = [
    { type: 'text', text: 'v2 response' },
  ]
) {
  const doGenerate = vi.fn(async (_options: LanguageModelV2CallOptions) => ({
    content,
    finishReason: 'stop' as const,
    usage: {
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 1,
    },
    response: { id: 'resp_v2' },
    warnings: [],
  }));
  const doStream = vi.fn(async (_options: LanguageModelV2CallOptions) => ({
    stream: streamOf<LanguageModelV2StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'hi' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: '{"q":"x"}' },
      {
        type: 'tool-call',
        toolCallId: 'tc2',
        toolName: 'web_search',
        input: '{}',
        providerExecuted: true,
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      },
    ]),
  }));
  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'mock.v2',
    modelId: 'mock-v2',
    supportedUrls: {},
    doGenerate,
    doStream,
  };
  return { model, doGenerate, doStream };
}

const v3Usage = {
  inputTokens: { total: 5, noCache: 3, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 10, text: 9, reasoning: 1 },
};

function v3Model() {
  const doGenerate = vi.fn(async (_options: LanguageModelV3CallOptions) => ({
    content: [
      { type: 'text' as const, text: 'v3 response' },
      {
        type: 'tool-call' as const,
        toolCallId: 'tc1',
        toolName: 'search',
        input: '{"q":"x"}',
        providerMetadata: { google: { thoughtSignature: 'sig-1' } },
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'TOOL_USE' },
    usage: v3Usage,
    warnings: [],
  }));
  const doStream = vi.fn(async (_options: LanguageModelV3CallOptions) => ({
    stream: streamOf<LanguageModelV3StreamPart>([
      { type: 'text-delta', id: 't1', delta: 'v3' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'STOP' }, usage: v3Usage },
    ]),
  }));
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'google.generative-ai',
    modelId: 'mock-v3',
    supportedUrls: {},
    doGenerate,
    doStream,
  };
  return { model, doGenerate, doStream };
}

function v4Model() {
  const doGenerate = vi.fn(async (_options: LanguageModelV4CallOptions) => ({
    content: [{ type: 'text' as const, text: 'v4 response' }],
    finishReason: { unified: 'length' as const, raw: 'max_tokens' },
    usage: v3Usage,
    warnings: [],
  }));
  const doStream = vi.fn(async (_options: LanguageModelV4CallOptions) => ({
    stream: streamOf<LanguageModelV4StreamPart>([
      { type: 'text-delta', id: 't1', delta: 'v4' },
      { type: 'error', error: new Error('stream broke') },
    ]),
  }));
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock.v4',
    modelId: 'mock-v4',
    supportedUrls: {},
    doGenerate,
    doStream,
  };
  return { model, doGenerate, doStream };
}

const conversation: Message[] = [
  { role: 'system', content: 'Be brief' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Look' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      { type: 'image_base64', image_base64: { data: 'aGVsbG8=', media_type: 'image/png' } },
    ],
  },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'cats' }, thoughtSignature: 'sig-1' }],
  } as Message,
  { role: 'tool', content: '{"hits":3}', toolCallId: 'tc1', name: 'search' },
  { role: 'tool', content: 'plain text', toolCallId: 'tc2', name: 'search' },
];

const searchSchema = {
  name: 'search',
  description: 'Search',
  parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] },
};

describe('AISDKBackend', () => {
  it('derives the provider from the model', () => {
    expect(new AISDKBackend(v2Model().model).provider).toBe('mock.v2');
    expect(fromAISDK(v1Model().model)).toBeInstanceOf(AISDKBackend);
  });

  describe('LanguageModelV1 (ai@4)', () => {
    it('maps the request to v1 call options', async () => {
      const { model, doGenerate } = v1Model();
      const signal = new AbortController().signal;

      await new AISDKBackend(model).chat(
        req({
          messages: conversation,
          tools: [searchSchema],
          toolChoice: 'required',
          temperature: 0.5,
          maxTokens: 100,
          topP: 0.9,
          stop: ['END'],
          responseFormat: { type: 'json_object' },
          signal,
        })
      );

      const options = doGenerate.mock.calls[0][0];
      expect(options).toMatchObject({
        inputFormat: 'messages',
        mode: {
          type: 'regular',
          tools: [{ type: 'function', name: 'search', parameters: searchSchema.parameters }],
          toolChoice: { type: 'required' },
        },
        temperature: 0.5,
        maxTokens: 100,
        topP: 0.9,
        stopSequences: ['END'],
        responseFormat: { type: 'json' },
        abortSignal: signal,
      });
      expect(options.prompt).toEqual([
        { role: 'system', content: 'Be brief' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', image: new URL('https://example.com/cat.png') },
            { type: 'image', image: Uint8Array.from(Buffer.from('hello')), mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', args: { q: 'cats' } },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'tc1', toolName: 'search', result: { hits: 3 } },
            { type: 'tool-result', toolCallId: 'tc2', toolName: 'search', result: 'plain text' },
          ],
        },
      ]);
    });

    it('parses text, tool calls and usage', async () => {
      const { model } = v1Model({
        doGenerate: async () => ({
          text: '',
          toolCalls: [
            { toolCallType: 'function', toolCallId: 'tc1', toolName: 'calc', args: '{"x":1}' },
          ],
          finishReason: 'tool-calls',
          usage: { promptTokens: 5, completionTokens: Number.NaN },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const response = await new AISDKBackend(model).chat(req());

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toEqual([{ id: 'tc1', name: 'calc', arguments: { x: 1 } }]);
      expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 0, totalTokens: 5 });
    });

    it('streams text and finish chunks', async () => {
      const chunks = await collectAsync(new AISDKBackend(v1Model().model).chatStream(req()));

      expect(chunks.map((chunk) => chunk.delta.content).filter(Boolean)).toEqual(['hel', 'lo']);
      expect(chunks.at(-1)).toMatchObject({
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      });
    });

    it('rejects tool arguments that are not a JSON object', async () => {
      const { model } = v1Model({
        doGenerate: async () => ({
          toolCalls: [
            { toolCallType: 'function', toolCallId: 'tc1', toolName: 'calc', args: '[1]' },
          ],
          finishReason: 'tool-calls',
          usage: { promptTokens: 1, completionTokens: 1 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      await expect(new AISDKBackend(model).chat(req())).rejects.toThrow('must be a JSON object');
    });
  });

  describe('LanguageModelV2 (ai@5)', () => {
    it('maps the request to v2 call options', async () => {
      const { model, doGenerate } = v2Model();

      await new AISDKBackend(model).chat(
        req({
          messages: conversation,
          tools: [searchSchema],
          toolChoice: { type: 'function', function: { name: 'search' } },
          maxTokens: 50,
          responseFormat: {
            type: 'json_schema',
            jsonSchema: { name: 'out', schema: { type: 'object' } },
          },
        })
      );

      const options = doGenerate.mock.calls[0][0];
      expect(options).toMatchObject({
        maxOutputTokens: 50,
        tools: [{ type: 'function', name: 'search', inputSchema: searchSchema.parameters }],
        toolChoice: { type: 'tool', toolName: 'search' },
        responseFormat: { type: 'json', name: 'out', schema: { type: 'object' } },
      });
      expect(options.prompt.slice(1)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'file', data: new URL('https://example.com/cat.png'), mediaType: 'image/*' },
            { type: 'file', data: 'aGVsbG8=', mediaType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'search',
              input: { q: 'cats' },
              providerOptions: { mock: { thoughtSignature: 'sig-1' } },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc1',
              toolName: 'search',
              output: { type: 'json', value: { hits: 3 } },
            },
            {
              type: 'tool-result',
              toolCallId: 'tc2',
              toolName: 'search',
              output: { type: 'text', value: 'plain text' },
            },
          ],
        },
      ]);
    });

    it('parses content, skipping provider-executed tool calls', async () => {
      const { model } = v2Model([
        { type: 'text', text: 'Hello ' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'world' },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: '' },
        {
          type: 'tool-call',
          toolCallId: 'tc2',
          toolName: 'web',
          input: '{}',
          providerExecuted: true,
        },
      ]);

      const response = await new AISDKBackend(model).chat(req());

      expect(response).toEqual({
        id: 'resp_v2',
        content: 'Hello world',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: {} }],
        finishReason: 'tool_calls',
        usage: {
          inputTokens: 5,
          outputTokens: 10,
          totalTokens: 15,
          cachedInputTokens: 2,
          reasoningTokens: 1,
        },
      });
    });

    it('streams text and client tool calls', async () => {
      const chunks: ChatStreamChunk[] = await collectAsync(
        new AISDKBackend(v2Model().model).chatStream(req())
      );

      expect(chunks.map((chunk) => chunk.delta)).toEqual([
        { content: 'hi' },
        { toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'x' } }] },
        {},
      ]);
      expect(chunks.at(-1)).toMatchObject({
        finishReason: 'tool_calls',
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      });
    });
  });

  describe('LanguageModelV3 (ai@6)', () => {
    it('parses structured finish reason, usage and thought signatures', async () => {
      const { model } = v3Model();

      const response = await new AISDKBackend(model).chat(req());

      expect(response.content).toBe('v3 response');
      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toEqual([
        { id: 'tc1', name: 'search', arguments: { q: 'x' }, thoughtSignature: 'sig-1' },
      ]);
      expect(response.usage).toEqual({
        inputTokens: 5,
        outputTokens: 10,
        totalTokens: 15,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      });
    });

    it('replays thought signatures under the provider metadata key', async () => {
      const { model, doGenerate } = v3Model();
      const backend = new AISDKBackend(model);
      const first = await backend.chat(req());

      await backend.chat(
        req({
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: first.toolCalls } as Message,
          ],
        })
      );

      expect(doGenerate.mock.calls[1][0].prompt[1]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'search',
            input: { q: 'x' },
            providerOptions: { google: { thoughtSignature: 'sig-1' } },
          },
        ],
      });
    });

    it('streams with v3 finish parts', async () => {
      const chunks = await collectAsync(new AISDKBackend(v3Model().model).chatStream(req()));

      expect(chunks[0].delta.content).toBe('v3');
      expect(chunks.at(-1)).toMatchObject({ finishReason: 'stop', usage: { totalTokens: 15 } });
    });
  });

  describe('LanguageModelV4 (ai@7)', () => {
    it('sends v4 file data and maps the finish reason', async () => {
      const { model, doGenerate } = v4Model();

      const response = await new AISDKBackend(model).chat(
        req({ messages: conversation.slice(0, 2) })
      );

      expect(response.finishReason).toBe('length');
      expect(response.content).toBe('v4 response');
      expect(doGenerate.mock.calls[0][0].prompt[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          {
            type: 'file',
            data: { type: 'url', url: new URL('https://example.com/cat.png') },
            mediaType: 'image/*',
          },
          { type: 'file', data: { type: 'data', data: 'aGVsbG8=' }, mediaType: 'image/png' },
        ],
      });
    });

    it('throws stream error parts', async () => {
      const chunks: ChatStreamChunk[] = [];
      await expect(async () => {
        for await (const chunk of new AISDKBackend(v4Model().model).chatStream(req())) {
          chunks.push(chunk);
        }
      }).rejects.toThrow('stream broke');
      expect(chunks).toEqual([{ id: expect.any(String), delta: { content: 'v4' } }]);
    });
  });
});
