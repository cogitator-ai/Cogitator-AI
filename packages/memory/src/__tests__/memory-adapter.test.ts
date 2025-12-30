import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryAdapter } from '../adapters/memory.js';
import type { Message } from '@cogitator/types';

describe('InMemoryAdapter', () => {
  let adapter: InMemoryAdapter;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects successfully', async () => {
      const result = await adapter.connect();
      expect(result.success).toBe(true);
    });

    it('disconnects and clears data', async () => {
      await adapter.createThread('agent1');
      expect(adapter.stats.threads).toBe(1);

      await adapter.disconnect();
      expect(adapter.stats.threads).toBe(0);
    });
  });

  describe('thread operations', () => {
    it('creates a thread', async () => {
      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
    });

    it('gets a thread', async () => {
      const created = await adapter.createThread('agent1');
      if (!created.success) throw new Error('Failed to create');

      const result = await adapter.getThread(created.data.id);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe(created.data.id);
      }
    });

    it('returns null for non-existent thread', async () => {
      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const created = await adapter.createThread('agent1', { a: 1 });
      if (!created.success) throw new Error('Failed to create');

      const result = await adapter.updateThread(created.data.id, { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
        expect(result.data.updatedAt.getTime()).toBeGreaterThanOrEqual(
          created.data.createdAt.getTime()
        );
      }
    });

    it('returns error for updating non-existent thread', async () => {
      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread and its entries', async () => {
      const created = await adapter.createThread('agent1');
      if (!created.success) throw new Error('Failed to create');

      const message: Message = { role: 'user', content: 'Hello' };
      await adapter.addEntry({
        threadId: created.data.id,
        message,
        tokenCount: 10,
      });

      await adapter.deleteThread(created.data.id);

      const threadResult = await adapter.getThread(created.data.id);
      expect(threadResult.success && threadResult.data).toBeNull();

      expect(adapter.stats.entries).toBe(0);
    });
  });

  describe('entry operations', () => {
    let threadId: string;
    const message: Message = { role: 'user', content: 'Hello' };

    beforeEach(async () => {
      const result = await adapter.createThread('agent1');
      if (!result.success) throw new Error('Failed to create thread');
      threadId = result.data.id;
    });

    it('adds an entry', async () => {
      const result = await adapter.addEntry({
        threadId,
        message,
        tokenCount: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^entry_/);
        expect(result.data.message).toEqual(message);
        expect(result.data.tokenCount).toBe(10);
      }
    });

    it('gets entries for a thread', async () => {
      await adapter.addEntry({ threadId, message: { role: 'user', content: 'One' }, tokenCount: 5 });
      await adapter.addEntry({ threadId, message: { role: 'assistant', content: 'Two' }, tokenCount: 5 });

      const result = await adapter.getEntries({ threadId });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].message.content).toBe('One');
        expect(result.data[1].message.content).toBe('Two');
      }
    });

    it('applies limit to entries', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `Message ${i}` },
          tokenCount: 5,
        });
      }

      const result = await adapter.getEntries({ threadId, limit: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].message.content).toBe('Message 3');
        expect(result.data[1].message.content).toBe('Message 4');
      }
    });

    it('filters by before/after dates', async () => {
      const before = new Date();
      await new Promise((r) => setTimeout(r, 10));
      await adapter.addEntry({ threadId, message: { role: 'user', content: 'After' }, tokenCount: 5 });

      const result = await adapter.getEntries({ threadId, before });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }

      const after = new Date(before.getTime() - 1);
      const result2 = await adapter.getEntries({ threadId, after });

      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.data).toHaveLength(1);
      }
    });

    it('excludes toolCalls when not requested', async () => {
      await adapter.addEntry({
        threadId,
        message,
        tokenCount: 10,
        toolCalls: [{ id: 'tc1', name: 'tool', arguments: {} }],
      });

      const result = await adapter.getEntries({ threadId, includeToolCalls: false });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].toolCalls).toBeUndefined();
      }
    });

    it('includes toolCalls when requested', async () => {
      await adapter.addEntry({
        threadId,
        message,
        tokenCount: 10,
        toolCalls: [{ id: 'tc1', name: 'tool', arguments: {} }],
      });

      const result = await adapter.getEntries({ threadId, includeToolCalls: true });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].toolCalls).toHaveLength(1);
      }
    });

    it('gets single entry by id', async () => {
      const added = await adapter.addEntry({ threadId, message, tokenCount: 10 });
      if (!added.success) throw new Error('Failed to add');

      const result = await adapter.getEntry(added.data.id);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.message).toEqual(message);
      }
    });

    it('deletes an entry', async () => {
      const added = await adapter.addEntry({ threadId, message, tokenCount: 10 });
      if (!added.success) throw new Error('Failed to add');

      await adapter.deleteEntry(added.data.id);

      const result = await adapter.getEntry(added.data.id);
      expect(result.success && result.data).toBeNull();
    });

    it('clears all entries in a thread', async () => {
      await adapter.addEntry({ threadId, message, tokenCount: 10 });
      await adapter.addEntry({ threadId, message, tokenCount: 10 });

      await adapter.clearThread(threadId);

      const result = await adapter.getEntries({ threadId });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  describe('max entries limit', () => {
    it('evicts oldest entries when limit reached', async () => {
      const limitedAdapter = new InMemoryAdapter({ provider: 'memory', maxEntries: 3 });
      await limitedAdapter.connect();

      const thread = await limitedAdapter.createThread('agent1');
      if (!thread.success) throw new Error('Failed');
      const threadId = thread.data.id;

      for (let i = 0; i < 5; i++) {
        await limitedAdapter.addEntry({
          threadId,
          message: { role: 'user', content: `Msg ${i}` },
          tokenCount: 5,
        });
      }

      expect(limitedAdapter.stats.entries).toBe(3);

      const result = await limitedAdapter.getEntries({ threadId });
      if (result.success) {
        expect(result.data[0].message.content).toBe('Msg 2');
        expect(result.data[2].message.content).toBe('Msg 4');
      }

      await limitedAdapter.disconnect();
    });
  });

  describe('provider property', () => {
    it('returns memory as provider', () => {
      expect(adapter.provider).toBe('memory');
    });
  });
});
