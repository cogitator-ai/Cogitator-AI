import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import type { CogitatorConfig, Message } from '@cogitator/types';

const mockResponses: Message[] = [];
let responseIndex = 0;

vi.mock('../llm/index.js', () => ({
  createLLMBackend: () => ({
    chat: vi.fn().mockImplementation(() => {
      const content = mockResponses[responseIndex]?.content ?? 'Mock response';
      responseIndex++;
      return Promise.resolve({
        id: 'mock-id',
        content,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      });
    }),
    chatStream: vi.fn(),
  }),
  parseModel: (model: string) => ({
    provider: 'ollama',
    model: model.replace('ollama/', ''),
  }),
}));

describe('Cogitator with Memory', () => {
  let cog: Cogitator;
  let agent: Agent;

  beforeEach(() => {
    responseIndex = 0;
    mockResponses.length = 0;
  });

  afterEach(async () => {
    if (cog) {
      await cog.close();
    }
  });

  describe('without memory configured', () => {
    it('works without memory', async () => {
      cog = new Cogitator();
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      mockResponses.push({ role: 'assistant', content: 'Hello!' });

      const result = await cog.run(agent, { input: 'Hi' });

      expect(result.output).toBe('Hello!');
      expect(result.threadId).toMatch(/^thread_/);
    });
  });

  describe('with memory configured', () => {
    const memoryConfig: CogitatorConfig = {
      memory: {
        adapter: 'memory',
        inMemory: { maxEntries: 1000 },
      },
    };

    it('initializes memory adapter on first run', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      mockResponses.push({ role: 'assistant', content: 'Hello!' });

      const result = await cog.run(agent, { input: 'Hi', threadId: 'thread_test1' });

      expect(result.output).toBe('Hello!');
      expect(result.threadId).toBe('thread_test1');
    });

    it('persists messages across runs with same threadId', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      const threadId = 'thread_persist';

      mockResponses.push({ role: 'assistant', content: 'Nice to meet you, Alex!' });
      await cog.run(agent, { input: 'My name is Alex', threadId });

      mockResponses.push({ role: 'assistant', content: 'Your name is Alex!' });
      const result2 = await cog.run(agent, { input: "What's my name?", threadId });

      expect(result2.output).toBe('Your name is Alex!');
      expect(result2.messages.length).toBeGreaterThan(2);
    });

    it('uses separate history for different threadIds', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      mockResponses.push({ role: 'assistant', content: 'Hello Thread 1!' });
      await cog.run(agent, { input: 'Thread 1 message', threadId: 'thread_1' });

      mockResponses.push({ role: 'assistant', content: 'Hello Thread 2!' });
      const result2 = await cog.run(agent, { input: 'Thread 2 message', threadId: 'thread_2' });

      expect(result2.messages.filter((m) => m.role === 'user').length).toBe(1);
    });

    it('respects useMemory=false option', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      const threadId = 'thread_nomem';

      mockResponses.push({ role: 'assistant', content: 'First response' });
      await cog.run(agent, { input: 'First message', threadId });

      mockResponses.push({ role: 'assistant', content: 'Second response' });
      const result2 = await cog.run(agent, {
        input: 'Second message',
        threadId,
        useMemory: false,
      });

      expect(result2.messages.length).toBe(3);
    });

    it('respects saveHistory=false option', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      const threadId = 'thread_nosave';

      mockResponses.push({ role: 'assistant', content: 'Not saved' });
      await cog.run(agent, { input: 'Temp message', threadId, saveHistory: false });

      mockResponses.push({ role: 'assistant', content: 'Fresh start' });
      const result2 = await cog.run(agent, { input: 'New message', threadId });

      expect(result2.messages.length).toBe(3);
    });

    it('closes memory adapter properly', async () => {
      cog = new Cogitator(memoryConfig);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      mockResponses.push({ role: 'assistant', content: 'Test' });
      await cog.run(agent, { input: 'Test', threadId: 'thread_close' });

      await expect(cog.close()).resolves.not.toThrow();

      await expect(cog.close()).resolves.not.toThrow();
    });
  });

  describe('with context builder', () => {
    const configWithBuilder: CogitatorConfig = {
      memory: {
        adapter: 'memory',
        inMemory: { maxEntries: 1000 },
        contextBuilder: {
          maxTokens: 1000,
          strategy: 'recent',
          includeSystemPrompt: true,
        },
      },
    };

    it('uses context builder when configured', async () => {
      cog = new Cogitator(configWithBuilder);
      agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        model: 'ollama/llama3.1:8b',
        instructions: 'You are helpful.',
      });

      mockResponses.push({ role: 'assistant', content: 'Built with context!' });
      const result = await cog.run(agent, { input: 'Hi', threadId: 'thread_ctx' });

      expect(result.output).toBe('Built with context!');
    });
  });
});
