import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CompactionService, type SummarizeFn } from '../compaction';
import { InMemoryAdapter } from '../adapters/memory';
import type { CompactionConfig, Message } from '@cogitator-ai/types';

describe('CompactionService', () => {
  let adapter: InMemoryAdapter;
  let summarize: SummarizeFn;
  let service: CompactionService;
  const threadId = 'session_telegram_user-1';

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    await adapter.createThread('agent-1', {}, threadId);

    summarize = vi.fn(async (messages: Message[]) => {
      return `Summary of ${messages.length} messages`;
    });

    service = new CompactionService({ adapter, summarize });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  async function addMessages(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await adapter.addEntry({
        threadId,
        message: { role, content: `Message ${i + 1}` } as Message,
        tokenCount: 10,
      });
    }
  }

  describe('summary strategy', () => {
    const config: CompactionConfig = {
      strategy: 'summary',
      threshold: 10,
      keepRecent: 4,
    };

    it('summarizes old messages and keeps recent ones', async () => {
      await addMessages(10);

      const result = await service.compact(threadId, config);

      expect(result.originalMessages).toBe(10);
      expect(result.compactedMessages).toBe(5);
      expect(result.summaryTokens).toBeGreaterThan(0);
      expect(summarize).toHaveBeenCalledOnce();

      const args = vi.mocked(summarize).mock.calls[0][0];
      expect(args).toHaveLength(6);

      const entries = await adapter.getEntries({ threadId });
      expect(entries.success).toBe(true);
      if (entries.success) {
        expect(entries.data).toHaveLength(5);

        const summary = entries.data.find((e) => e.message.content.includes('Summary'));
        expect(summary).toBeDefined();
        expect(summary!.message.role).toBe('system');
        expect(summary!.message.content).toContain('Summary of 6 messages');

        const kept = entries.data.filter((e) => !e.message.content.includes('Summary'));
        expect(kept).toHaveLength(4);
        expect(kept[0].message.content).toBe('Message 7');
        expect(kept[3].message.content).toBe('Message 10');
      }
    });

    it('does nothing when messages <= keepRecent', async () => {
      await addMessages(3);

      const result = await service.compact(threadId, config);

      expect(result.originalMessages).toBe(3);
      expect(result.compactedMessages).toBe(3);
      expect(result.summaryTokens).toBe(0);
      expect(summarize).not.toHaveBeenCalled();
    });
  });

  describe('sliding-window strategy', () => {
    const config: CompactionConfig = {
      strategy: 'sliding-window',
      threshold: 10,
      keepRecent: 4,
    };

    it('drops old messages without summarization', async () => {
      await addMessages(10);

      const result = await service.compact(threadId, config);

      expect(result.originalMessages).toBe(10);
      expect(result.compactedMessages).toBe(4);
      expect(result.summaryTokens).toBe(0);
      expect(summarize).not.toHaveBeenCalled();

      const entries = await adapter.getEntries({ threadId });
      if (entries.success) {
        expect(entries.data).toHaveLength(4);
        expect(entries.data[0].message.content).toBe('Message 7');
        expect(entries.data[3].message.content).toBe('Message 10');
      }
    });
  });

  describe('hybrid strategy', () => {
    const config: CompactionConfig = {
      strategy: 'hybrid',
      threshold: 10,
      keepRecent: 4,
    };

    it('uses summary when many old messages', async () => {
      await addMessages(12);

      const result = await service.compact(threadId, config);

      expect(result.compactedMessages).toBe(5);
      expect(result.summaryTokens).toBeGreaterThan(0);
      expect(summarize).toHaveBeenCalledOnce();
    });

    it('uses sliding-window when few old messages', async () => {
      await addMessages(7);

      const config: CompactionConfig = {
        strategy: 'hybrid',
        threshold: 5,
        keepRecent: 4,
      };

      const result = await service.compact(threadId, config);

      expect(result.summaryTokens).toBe(0);
      expect(summarize).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('returns no-op result when thread is empty', async () => {
      const result = await service.compact(threadId, {
        strategy: 'summary',
        threshold: 10,
        keepRecent: 4,
      });

      expect(result.originalMessages).toBe(0);
      expect(result.compactedMessages).toBe(0);
      expect(result.summaryTokens).toBe(0);
    });
  });
});
