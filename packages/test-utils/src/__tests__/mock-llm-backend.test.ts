import { describe, it, expect, beforeEach } from 'vitest';
import type { Message } from '@cogitator-ai/types';
import { MockLLMBackend, createMockLLMBackend } from '../mocks/mock-llm-backend';
import { collectStreamContent } from '../helpers/streams';

describe('MockLLMBackend', () => {
  let backend: MockLLMBackend;

  beforeEach(() => {
    backend = createMockLLMBackend();
  });

  describe('chat()', () => {
    it('returns default empty response when no response set', async () => {
      const response = await backend.chat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('');
      expect(response.finishReason).toBe('stop');
      expect(response.id).toMatch(/^mock_/);
    });

    it('records each call as it was sent, though the caller keeps appending to its messages', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];

      await backend.chat({ model: 'test-model', messages });
      messages.push({ role: 'assistant', content: '' }, { role: 'user', content: 'More' });
      await backend.chat({ model: 'test-model', messages });
      messages.push({ role: 'assistant', content: '' });
      const stream = backend.chatStream({ model: 'test-model', messages });
      await stream.next();
      messages.push({ role: 'user', content: 'Later' });

      expect(backend.getCalls().map((call) => call.messages.length)).toEqual([1, 3, 4]);
    });

    it('returns configured response', async () => {
      backend.setResponse({ content: 'Hello, world!' });

      const response = await backend.chat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toBe('Hello, world!');
    });

    it('returns multiple responses in sequence', async () => {
      backend.setResponses([{ content: 'First response' }, { content: 'Second response' }]);

      const r1 = await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'A' }] });
      const r2 = await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'B' }] });
      const r3 = await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'C' }] });

      expect(r1.content).toBe('First response');
      expect(r2.content).toBe('Second response');
      expect(r3.content).toBe('Second response');
    });

    it('returns tool calls response', async () => {
      backend.setToolCallResponse([
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Tokyo' } },
      ]);

      const response = await backend.chat({
        model: 'test',
        messages: [{ role: 'user', content: 'Weather?' }],
      });

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].name).toBe('get_weather');
    });

    it('throws error when error is set', async () => {
      backend.setResponse({ error: new Error('API Error') });

      await expect(
        backend.chat({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] })
      ).rejects.toThrow('API Error');
    });

    it('records all calls', async () => {
      await backend.chat({ model: 'model-a', messages: [{ role: 'user', content: 'First' }] });
      await backend.chat({ model: 'model-b', messages: [{ role: 'user', content: 'Second' }] });

      const calls = backend.getCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0].model).toBe('model-a');
      expect(calls[1].model).toBe('model-b');
    });

    it('returns last call', async () => {
      await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'First' }] });
      await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'Last' }] });

      const lastCall = backend.getLastCall();
      expect(lastCall?.messages[0].content).toBe('Last');
    });

    it('estimates token usage', async () => {
      const response = await backend.chat({
        model: 'test',
        messages: [{ role: 'user', content: 'Hello world' }],
      });

      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(response.usage.totalTokens).toBe(
        response.usage.inputTokens + response.usage.outputTokens
      );
    });

    it('respects configured delay', async () => {
      backend.setResponse({ content: 'Delayed', delay: 50 });

      const start = Date.now();
      await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe('chatStream()', () => {
    it('streams configured chunks', async () => {
      backend.setStreamChunks([{ content: 'Hello' }, { content: ' world' }, { content: '!' }]);

      const content = await collectStreamContent(
        backend.chatStream({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] })
      );

      expect(content).toBe('Hello world!');
    });

    it('streams tool calls', async () => {
      backend.setStreamChunks([
        { toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expr: '2+2' } }] },
      ]);

      const chunks = [];
      for await (const chunk of backend.chatStream({
        model: 'test',
        messages: [{ role: 'user', content: 'Calculate' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0].delta.toolCalls).toBeDefined();
      expect(chunks[0].delta.toolCalls![0].name).toBe('calculator');
    });

    it('includes usage in last chunk', async () => {
      backend.setStreamChunks([{ content: 'Test' }]);

      const chunks = [];
      for await (const chunk of backend.chatStream({
        model: 'test',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.usage).toBeDefined();
      expect(lastChunk.finishReason).toBe('stop');
    });
  });

  describe('reset()', () => {
    it('clears all state', async () => {
      backend.setResponse({ content: 'Test' });
      await backend.chat({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] });

      backend.reset();

      expect(backend.getCalls()).toHaveLength(0);
      expect(backend.getCallCount()).toBe(0);
    });
  });

  describe('wasCalledWith()', () => {
    it('returns true when predicate matches', async () => {
      await backend.chat({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(backend.wasCalledWith((req) => req.model === 'gpt-4')).toBe(true);
      expect(backend.wasCalledWith((req) => req.model === 'claude')).toBe(false);
    });
  });
});
