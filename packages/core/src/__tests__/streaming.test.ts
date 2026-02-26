import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatStreamChunk, LLMBackend, Message, ToolCall } from '@cogitator-ai/types';
import { streamChat } from '../cogitator/streaming';
import { ToolRegistry } from '../registry';
import type { Agent } from '../agent';

function createMockBackend(chunks: ChatStreamChunk[]): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn(),
    async *chatStream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LLMBackend;
}

function createMockAgent(): Agent {
  return {
    id: 'agent_test',
    config: {
      temperature: 0.7,
      topP: undefined,
      maxTokens: undefined,
      stopSequences: undefined,
    },
  } as unknown as Agent;
}

describe('streamChat', () => {
  let registry: ToolRegistry;
  let agent: Agent;
  let messages: Message[];
  let onToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    agent = createMockAgent();
    messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    onToken = vi.fn();
  });

  it('accumulates tool calls by ID across chunks', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { query: 'hello' } }],
        },
      },
      {
        id: 'chunk_2',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { limit: 10 } }],
        },
      },
      {
        id: 'chunk_3',
        delta: {},
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'tc_1',
      name: 'search',
      arguments: { query: 'hello', limit: 10 },
    });
  });

  it('does not add incomplete tool calls missing id', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ name: 'search', arguments: { query: 'test' } } as Partial<ToolCall>],
        },
      },
      {
        id: 'chunk_2',
        delta: {},
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toEqual([]);
  });

  it('does not add incomplete tool calls missing name', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ id: 'tc_1', arguments: { query: 'test' } } as Partial<ToolCall>],
        },
      },
      {
        id: 'chunk_2',
        delta: {},
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toEqual([]);
  });

  it('merges multiple distinct tool calls from separate chunks', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { query: 'cats' } }],
        },
      },
      {
        id: 'chunk_2',
        delta: {
          toolCalls: [{ id: 'tc_2', name: 'fetch', arguments: { url: 'https://example.com' } }],
        },
      },
      {
        id: 'chunk_3',
        delta: {},
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].id).toBe('tc_1');
    expect(result.toolCalls![0].name).toBe('search');
    expect(result.toolCalls![1].id).toBe('tc_2');
    expect(result.toolCalls![1].name).toBe('fetch');
  });

  it('merges arguments across chunks for the same tool call ID', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { query: 'hello' } }],
        },
      },
      {
        id: 'chunk_2',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { limit: 5 } }],
        },
      },
      {
        id: 'chunk_3',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { offset: 0 } }],
        },
      },
      {
        id: 'chunk_4',
        delta: {},
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].arguments).toEqual({
      query: 'hello',
      limit: 5,
      offset: 0,
    });
  });

  it('accumulates text content and invokes onToken', async () => {
    const chunks: ChatStreamChunk[] = [
      { id: 'c1', delta: { content: 'Hello' } },
      { id: 'c2', delta: { content: ' world' } },
      {
        id: 'c3',
        delta: {},
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.content).toBe('Hello world');
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenCalledWith('Hello');
    expect(onToken).toHaveBeenCalledWith(' world');
  });

  it('defaults arguments to empty object when chunk has no arguments', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 'chunk_1',
        delta: {
          toolCalls: [{ id: 'tc_1', name: 'ping' } as Partial<ToolCall>],
        },
      },
      {
        id: 'chunk_2',
        delta: {},
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    ];

    const backend = createMockBackend(chunks);
    const result = await streamChat(backend, 'gpt-4', messages, registry, agent, onToken);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].arguments).toEqual({});
  });
});
