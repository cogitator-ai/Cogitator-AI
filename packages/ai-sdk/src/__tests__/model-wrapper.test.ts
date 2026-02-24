import { describe, it, expect, vi } from 'vitest';
import { fromAISDK, AISDKBackend } from '../model-wrapper';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import type { ChatRequest } from '@cogitator-ai/types';

function makeMockModel(overrides: Partial<LanguageModelV1> = {}): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'mock-provider',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',
    doGenerate: vi.fn().mockResolvedValue({
      text: 'mock response',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 10 },
      rawCall: { rawPrompt: '', rawSettings: {} },
    }),
    doStream: vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', textDelta: 'hello' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 3, completionTokens: 7 },
          });
          controller.close();
        },
      }),
      rawCall: { rawPrompt: '', rawSettings: {} },
    }),
    ...overrides,
  };
}

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
    ...overrides,
  };
}

describe('AISDKBackend', () => {
  it('derives provider from model', () => {
    const model = makeMockModel({ provider: 'anthropic' });
    const backend = new AISDKBackend(model);
    expect(backend.provider).toBe('anthropic');
  });

  it('defaults provider to ai-sdk when model has no provider', () => {
    const model = makeMockModel({ provider: undefined as unknown as string });
    const backend = new AISDKBackend(model);
    expect(backend.provider).toBe('ai-sdk');
  });

  describe('chat', () => {
    it('sends messages and returns response', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      const response = await backend.chat(
        req({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      );

      expect(response.content).toBe('mock response');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.inputTokens).toBe(5);
      expect(response.usage.outputTokens).toBe(10);
      expect(response.usage.totalTokens).toBe(15);
      expect(response.id).toMatch(/^aisdk-/);
    });

    it('handles system messages', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      await backend.chat(
        req({
          messages: [
            { role: 'system', content: 'Be brief' },
            { role: 'user', content: 'Hi' },
          ],
        })
      );

      const call = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.prompt[0]).toEqual({ role: 'system', content: 'Be brief' });
    });

    it('handles tool messages by converting to user role', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      await backend.chat(
        req({
          messages: [
            { role: 'user', content: 'Search for cats' },
            { role: 'tool', content: 'Found 5 cats', name: 'search' },
          ],
        })
      );

      const call = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMessages = call.prompt.filter((m: { role: string }) => m.role === 'user');
      expect(userMessages[1].content[0].text).toContain('[Tool result for search]');
    });

    it('handles multipart content messages', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      await backend.chat(
        req({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'part1' },
                { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
                { type: 'text', text: 'part2' },
              ],
            },
          ],
        })
      );

      const call = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.prompt[0].content[0].text).toBe('part1\npart2');
    });

    it('passes tools configuration', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      await backend.chat(
        req({
          messages: [{ role: 'user', content: 'test' }],
          tools: [
            {
              name: 'search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          ],
        })
      );

      const call = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.mode.type).toBe('regular');
      expect(call.mode.tools).toHaveLength(1);
      expect(call.mode.tools[0].name).toBe('search');
    });

    it('parses tool calls from response', async () => {
      const model = makeMockModel({
        doGenerate: vi.fn().mockResolvedValue({
          text: '',
          toolCalls: [
            { toolCallType: 'function', toolCallId: 'tc1', toolName: 'calc', args: '{"x":1}' },
          ],
          finishReason: 'tool-calls',
          usage: { promptTokens: 5, completionTokens: 10 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const response = await backend.chat(
        req({
          messages: [{ role: 'user', content: 'calc' }],
        })
      );

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].id).toBe('tc1');
      expect(response.toolCalls![0].name).toBe('calc');
      expect(response.toolCalls![0].arguments).toEqual({ x: 1 });
    });

    it('passes temperature and other params', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      await backend.chat(
        req({
          messages: [{ role: 'user', content: 'test' }],
          temperature: 0.5,
          maxTokens: 100,
          topP: 0.9,
          stop: ['END'],
        })
      );

      const call = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.temperature).toBe(0.5);
      expect(call.maxTokens).toBe(100);
      expect(call.topP).toBe(0.9);
      expect(call.stopSequences).toEqual(['END']);
    });
  });

  describe('chatStream', () => {
    it('yields text deltas', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      const chunks: unknown[] = [];
      for await (const chunk of backend.chatStream(
        req({
          messages: [{ role: 'user', content: 'stream test' }],
        })
      )) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const textChunk = chunks.find(
        (c: unknown) => (c as { delta: { content?: string } }).delta?.content !== undefined
      );
      expect(textChunk).toBeDefined();
    });

    it('yields tool call chunks', async () => {
      const model = makeMockModel({
        doStream: vi.fn().mockResolvedValue({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: 'tc1',
                toolName: 'search',
                args: '{"q":"test"}',
              });
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { promptTokens: 5, completionTokens: 10 },
              });
              controller.close();
            },
          }),
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const chunks: unknown[] = [];
      for await (const chunk of backend.chatStream(
        req({
          messages: [{ role: 'user', content: 'search' }],
        })
      )) {
        chunks.push(chunk);
      }

      const toolChunk = chunks.find(
        (c: unknown) => (c as { delta: { toolCalls?: unknown[] } }).delta?.toolCalls !== undefined
      );
      expect(toolChunk).toBeDefined();

      const finishChunk = chunks.find(
        (c: unknown) => (c as { finishReason?: string }).finishReason === 'tool_calls'
      );
      expect(finishChunk).toBeDefined();
    });

    it('yields finish with usage', async () => {
      const model = makeMockModel();
      const backend = new AISDKBackend(model);

      const chunks: unknown[] = [];
      for await (const chunk of backend.chatStream(
        req({
          messages: [{ role: 'user', content: 'test' }],
        })
      )) {
        chunks.push(chunk);
      }

      const finishChunk = chunks.find(
        (c: unknown) => (c as { usage?: unknown }).usage !== undefined
      ) as { usage: { inputTokens: number; outputTokens: number; totalTokens: number } };
      expect(finishChunk).toBeDefined();
      expect(finishChunk.usage.inputTokens).toBe(3);
      expect(finishChunk.usage.outputTokens).toBe(7);
      expect(finishChunk.usage.totalTokens).toBe(10);
    });
  });

  describe('chatStream error handling', () => {
    it('handles finish with no usage gracefully', async () => {
      const model = makeMockModel({
        doStream: vi.fn().mockResolvedValue({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'finish',
                finishReason: 'length',
                usage: undefined,
              });
              controller.close();
            },
          }),
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const chunks: unknown[] = [];
      for await (const chunk of backend.chatStream(
        req({
          messages: [{ role: 'user', content: 'test' }],
        })
      )) {
        chunks.push(chunk);
      }

      const finishChunk = chunks.find(
        (c: unknown) => (c as { finishReason?: string }).finishReason === 'length'
      ) as { usage: { inputTokens: number; outputTokens: number } };
      expect(finishChunk).toBeDefined();
      expect(finishChunk.usage.inputTokens).toBe(0);
      expect(finishChunk.usage.outputTokens).toBe(0);
    });
  });

  describe('finish reason mapping', () => {
    it('maps error finish reason', async () => {
      const model = makeMockModel({
        doGenerate: vi.fn().mockResolvedValue({
          text: '',
          finishReason: 'error',
          usage: { promptTokens: 0, completionTokens: 0 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const response = await backend.chat(
        req({
          messages: [{ role: 'user', content: 'test' }],
        })
      );
      expect(response.finishReason).toBe('error');
    });

    it('maps length finish reason', async () => {
      const model = makeMockModel({
        doGenerate: vi.fn().mockResolvedValue({
          text: 'truncated',
          finishReason: 'length',
          usage: { promptTokens: 100, completionTokens: 4096 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const response = await backend.chat(
        req({
          messages: [{ role: 'user', content: 'test' }],
        })
      );
      expect(response.finishReason).toBe('length');
    });

    it('maps unknown finish reason to stop', async () => {
      const model = makeMockModel({
        doGenerate: vi.fn().mockResolvedValue({
          text: '',
          finishReason: 'content-filter',
          usage: { promptTokens: 0, completionTokens: 0 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
      });

      const backend = new AISDKBackend(model);
      const response = await backend.chat(
        req({
          messages: [{ role: 'user', content: 'test' }],
        })
      );
      expect(response.finishReason).toBe('stop');
    });
  });
});

describe('fromAISDK', () => {
  it('returns an AISDKBackend instance', () => {
    const model = makeMockModel();
    const backend = fromAISDK(model);
    expect(backend).toBeInstanceOf(AISDKBackend);
  });
});
