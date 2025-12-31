import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextBuilder } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
import type { Message } from '@cogitator-ai/types';

describe('ContextBuilder', () => {
  let adapter: InMemoryAdapter;
  let threadId: string;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();

    const thread = await adapter.createThread('agent1');
    if (!thread.success) throw new Error('Failed to create thread');
    threadId = thread.data.id;
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('basic context building', () => {
    it('builds empty context for empty thread', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(0);
      expect(result.tokenCount).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('includes system prompt when provided', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'You are helpful.',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('You are helpful.');
    });

    it('excludes system prompt when disabled', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: false },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'You are helpful.',
      });

      expect(result.messages).toHaveLength(0);
    });
  });

  describe('recent strategy', () => {
    it('includes all messages when they fit', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      for (const msg of messages) {
        await adapter.addEntry({ threadId, message: msg, tokenCount: 10 });
      }

      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(3);
      expect(result.truncated).toBe(false);
    });

    it('truncates oldest messages when exceeding limit', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `Message ${i}` },
          tokenCount: 10,
        });
      }

      const builder = new ContextBuilder(
        { maxTokens: 35, reserveTokens: 5, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(3);
      expect(result.truncated).toBe(true);
      expect(result.messages[0].content).toBe('Message 2');
      expect(result.messages[2].content).toBe('Message 4');
    });

    it('respects reserve tokens', async () => {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'Hello' },
        tokenCount: 50,
      });

      const builder = new ContextBuilder(
        { maxTokens: 100, reserveTokens: 60, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });
  });

  describe('metadata tracking', () => {
    it('tracks original and included message counts', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `Msg ${i}` },
          tokenCount: 10,
        });
      }

      const builder = new ContextBuilder(
        { maxTokens: 35, reserveTokens: 5, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.metadata.originalMessageCount).toBe(5);
      expect(result.metadata.includedMessageCount).toBe(3);
    });

    it('tracks token count correctly', async () => {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'Hello' },
        tokenCount: 15,
      });
      await adapter.addEntry({
        threadId,
        message: { role: 'assistant', content: 'Hi' },
        tokenCount: 10,
      });

      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.tokenCount).toBe(25);
    });

    it('includes system prompt tokens in count', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'Be helpful.',
      });

      expect(result.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('empty facts and semantic results', () => {
    it('returns empty arrays when adapters not provided', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.facts).toHaveLength(0);
      expect(result.semanticResults).toHaveLength(0);
      expect(result.metadata.factsIncluded).toBe(0);
      expect(result.metadata.semanticResultsIncluded).toBe(0);
    });
  });
});
