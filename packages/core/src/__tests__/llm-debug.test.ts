import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMBackend, ChatRequest, ChatResponse, ChatStreamChunk } from '@cogitator-ai/types';
import { LLMDebugWrapper, withDebug, type LLMDebugLogger } from '../llm/debug';

function makeMockBackend(overrides?: Partial<LLMBackend>): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn().mockResolvedValue({
      id: 'resp-1',
      content: 'Hello world',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } satisfies ChatResponse),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield { id: 'chunk-1', delta: { content: 'Hi' } } satisfies ChatStreamChunk;
      yield {
        id: 'chunk-2',
        delta: { content: '!' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      } satisfies ChatStreamChunk;
    }),
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function makeSilentLogger(): LLMDebugLogger & {
  calls: Array<{ level: string; message: string; data?: unknown }>;
} {
  const calls: Array<{ level: string; message: string; data?: unknown }> = [];
  return {
    calls,
    log(level, message, data) {
      calls.push({ level, message, data });
    },
  };
}

describe('LLMDebugWrapper', () => {
  let backend: LLMBackend;
  let logger: ReturnType<typeof makeSilentLogger>;

  beforeEach(() => {
    backend = makeMockBackend();
    logger = makeSilentLogger();
  });

  it('delegates chat() to wrapped backend', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger });
    const request = makeRequest();

    const result = await wrapper.chat(request);

    expect(backend.chat).toHaveBeenCalledWith(request);
    expect(result.id).toBe('resp-1');
    expect(result.content).toBe('Hello world');
  });

  it('calls onRequest/onResponse callbacks via logger', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger });

    await wrapper.chat(makeRequest());

    const requestLog = logger.calls.find((c) => c.message.includes('Chat request'));
    const responseLog = logger.calls.find((c) => c.message.includes('Response'));
    expect(requestLog).toBeDefined();
    expect(requestLog!.level).toBe('info');
    expect(responseLog).toBeDefined();
    expect(responseLog!.level).toBe('info');
  });

  it('sanitizes image_url data in logged requests', async () => {
    const request = makeRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/secret-image.jpg', detail: 'high' },
            },
          ],
        },
      ],
    });

    const wrapper = new LLMDebugWrapper(backend, { logger });
    await wrapper.chat(request);

    const requestLog = logger.calls.find((c) => c.message.includes('Chat request'));
    const logData = requestLog!.data as Record<string, unknown>;
    const messages = logData.messages as Array<{ content: unknown }>;
    const parts = messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart!.image_url!.url).toBe('[image]');
  });

  it('sanitizes image_base64 data in logged requests', async () => {
    const request = makeRequest({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_base64',
              image_base64: { data: 'aGVsbG8gd29ybGQ=', media_type: 'image/png' },
            },
          ],
        },
      ],
    });

    const wrapper = new LLMDebugWrapper(backend, { logger });
    await wrapper.chat(request);

    const requestLog = logger.calls.find((c) => c.message.includes('Chat request'));
    const logData = requestLog!.data as Record<string, unknown>;
    const messages = logData.messages as Array<{ content: unknown }>;
    const parts = messages[0].content as Array<{
      type: string;
      image_base64?: { data: string; media_type: string };
    }>;
    const imagePart = parts.find((p) => p.type === 'image_base64');
    expect(imagePart!.image_base64!.data).toBe('[base64 image/png]');
    expect(imagePart!.image_base64!.media_type).toBe('image/png');
  });

  it('wraps chatStream() and yields all chunks', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger, logStream: true });
    const chunks: ChatStreamChunk[] = [];

    for await (const chunk of wrapper.chatStream(makeRequest())) {
      chunks.push(chunk);
    }

    expect(backend.chatStream).toHaveBeenCalled();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].delta.content).toBe('Hi');
    expect(chunks[1].delta.content).toBe('!');
    expect(chunks[1].finishReason).toBe('stop');
  });

  it('logs stream chunks when logStream is enabled', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger, logStream: true });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of wrapper.chatStream(makeRequest())) {
      chunks.push(chunk);
    }

    const streamChunkLogs = logger.calls.filter((c) => c.message.includes('Stream chunk'));
    expect(streamChunkLogs).toHaveLength(2);
  });

  it('logs stream complete after consuming all chunks', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger });

    for await (const _chunk of wrapper.chatStream(makeRequest())) {
      /* consume */
    }

    const completeLog = logger.calls.find((c) => c.message.includes('Stream complete'));
    expect(completeLog).toBeDefined();
    expect(completeLog!.level).toBe('info');

    const data = completeLog!.data as Record<string, unknown>;
    expect(data.chunkCount).toBe(2);
    expect(data.contentLength).toBe(3);
    expect(data.content).toBe('Hi!');
  });

  it('keeps only a bounded stream content preview', async () => {
    const longStreamBackend = makeMockBackend({
      chatStream: vi.fn().mockImplementation(async function* () {
        yield { id: 'chunk-1', delta: { content: 'A'.repeat(20) } } satisfies ChatStreamChunk;
        yield {
          id: 'chunk-2',
          delta: { content: 'B'.repeat(20) },
          finishReason: 'stop',
        } satisfies ChatStreamChunk;
      }),
    });
    const wrapper = new LLMDebugWrapper(longStreamBackend, { logger, maxContentLength: 10 });

    for await (const _chunk of wrapper.chatStream(makeRequest())) {
      /* consume */
    }

    const completeLog = logger.calls.find((c) => c.message.includes('Stream complete'));
    const data = completeLog!.data as Record<string, unknown>;
    expect(data.contentLength).toBe(40);
    expect(data.content).toBe('A'.repeat(10) + '... [truncated]');
  });

  it('skips logging when enabled=false', async () => {
    const wrapper = new LLMDebugWrapper(backend, { enabled: false, logger });

    await wrapper.chat(makeRequest());

    expect(backend.chat).toHaveBeenCalled();
    expect(logger.calls).toHaveLength(0);
  });

  it('skips stream logging when enabled=false', async () => {
    const wrapper = new LLMDebugWrapper(backend, { enabled: false, logger });

    for await (const _chunk of wrapper.chatStream(makeRequest())) {
      /* consume */
    }

    expect(backend.chatStream).toHaveBeenCalled();
    expect(logger.calls).toHaveLength(0);
  });

  it('logs error when chat() throws', async () => {
    const failingBackend = makeMockBackend({
      chat: vi.fn().mockRejectedValue(new Error('API timeout')),
    });
    const wrapper = new LLMDebugWrapper(failingBackend, { logger });

    await expect(wrapper.chat(makeRequest())).rejects.toThrow('API timeout');

    const errorLog = logger.calls.find((c) => c.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog!.message).toContain('Request failed');
  });

  it('preserves the provider from the wrapped backend', () => {
    const googleBackend = makeMockBackend({ provider: 'google' });
    const wrapper = new LLMDebugWrapper(googleBackend, { logger });
    expect(wrapper.provider).toBe('google');
  });

  it('truncates long content in logged messages', async () => {
    const wrapper = new LLMDebugWrapper(backend, { logger, maxContentLength: 20 });

    const request = makeRequest({
      messages: [{ role: 'user', content: 'A'.repeat(100) }],
    });
    await wrapper.chat(request);

    const requestLog = logger.calls.find((c) => c.message.includes('Chat request'));
    const logData = requestLog!.data as Record<string, unknown>;
    const messages = logData.messages as Array<{ content: string }>;
    expect(messages[0].content).toBe('A'.repeat(20) + '... [truncated]');
  });
});

describe('withDebug', () => {
  it('creates LLMDebugWrapper from backend + options', () => {
    const backend = makeMockBackend();
    const result = withDebug(backend, { enabled: true });

    expect(result).toBeInstanceOf(LLMDebugWrapper);
    expect(result.provider).toBe('openai');
  });

  it('creates wrapper with default options when none provided', () => {
    const backend = makeMockBackend();
    const result = withDebug(backend);
    expect(result).toBeInstanceOf(LLMDebugWrapper);
  });
});
