import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemoryAdapter, ContextBuilder } from '@cogitator-ai/memory';
import type { MemoryEntry } from '@cogitator-ai/types';
import { createTestMemoryAdapter } from '../../helpers/setup';

describe('Memory: Adapter Operations', () => {
  let adapter: InMemoryAdapter;

  beforeAll(async () => {
    adapter = createTestMemoryAdapter();
    await adapter.connect();
  });

  afterAll(async () => {
    await adapter.disconnect();
  });

  it('creates thread and stores entries', async () => {
    const threadResult = await adapter.createThread('agent-1', { topic: 'greetings' });
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;
    expect(threadResult.data.agentId).toBe('agent-1');
    expect(threadResult.data.metadata.topic).toBe('greetings');

    const entries = [
      { role: 'user' as const, content: 'Hello there' },
      { role: 'assistant' as const, content: 'Hi! How can I help?' },
      { role: 'user' as const, content: 'Tell me about memory adapters' },
    ];

    for (const msg of entries) {
      const result = await adapter.addEntry({
        threadId,
        message: msg,
        tokenCount: 10,
      });
      expect(result.success).toBe(true);
    }

    const retrieved = await adapter.getEntries({ threadId });
    expect(retrieved.success).toBe(true);
    if (!retrieved.success) return;

    expect(retrieved.data).toHaveLength(3);
    expect(retrieved.data[0].message.content).toBe('Hello there');
    expect(retrieved.data[1].message.content).toBe('Hi! How can I help?');
    expect(retrieved.data[2].message.content).toBe('Tell me about memory adapters');
  });

  it('retrieves entries in chronological order', async () => {
    const threadResult = await adapter.createThread('agent-2');
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;

    const messages: Omit<MemoryEntry, 'id' | 'createdAt'>[] = [
      { threadId, message: { role: 'system', content: 'You are helpful' }, tokenCount: 5 },
      { threadId, message: { role: 'user', content: 'First question' }, tokenCount: 8 },
      { threadId, message: { role: 'assistant', content: 'First answer' }, tokenCount: 12 },
      { threadId, message: { role: 'user', content: 'Second question' }, tokenCount: 8 },
      { threadId, message: { role: 'assistant', content: 'Second answer' }, tokenCount: 12 },
    ];

    for (const msg of messages) {
      await adapter.addEntry(msg);
    }

    const result = await adapter.getEntries({ threadId });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(5);

    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.data[i - 1].createdAt.getTime()
      );
    }

    expect(result.data[0].message.role).toBe('system');
    expect(result.data[1].message.role).toBe('user');
    expect(result.data[2].message.role).toBe('assistant');
  });

  it('clears thread entries without deleting thread', async () => {
    const threadResult = await adapter.createThread('agent-3', { persistent: true });
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;

    for (let i = 0; i < 4; i++) {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: `Message ${i}` },
        tokenCount: 5,
      });
    }

    const beforeClear = await adapter.getEntries({ threadId });
    expect(beforeClear.success).toBe(true);
    if (beforeClear.success) {
      expect(beforeClear.data).toHaveLength(4);
    }

    const clearResult = await adapter.clearThread(threadId);
    expect(clearResult.success).toBe(true);

    const afterClear = await adapter.getEntries({ threadId });
    expect(afterClear.success).toBe(true);
    if (afterClear.success) {
      expect(afterClear.data).toHaveLength(0);
    }

    const threadStillExists = await adapter.getThread(threadId);
    expect(threadStillExists.success).toBe(true);
    if (threadStillExists.success) {
      expect(threadStillExists.data).not.toBeNull();
      expect(threadStillExists.data!.id).toBe(threadId);
      expect(threadStillExists.data!.metadata.persistent).toBe(true);
    }
  });

  it('deletes thread and all entries', async () => {
    const threadResult = await adapter.createThread('agent-4');
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;
    const entryIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const entry = await adapter.addEntry({
        threadId,
        message: { role: 'user', content: `Entry ${i}` },
        tokenCount: 5,
      });
      if (entry.success) entryIds.push(entry.data.id);
    }

    expect(entryIds).toHaveLength(3);

    const deleteResult = await adapter.deleteThread(threadId);
    expect(deleteResult.success).toBe(true);

    const threadGone = await adapter.getThread(threadId);
    expect(threadGone.success).toBe(true);
    if (threadGone.success) {
      expect(threadGone.data).toBeNull();
    }

    const entriesGone = await adapter.getEntries({ threadId });
    expect(entriesGone.success).toBe(true);
    if (entriesGone.success) {
      expect(entriesGone.data).toHaveLength(0);
    }

    for (const id of entryIds) {
      const entry = await adapter.getEntry(id);
      expect(entry.success).toBe(true);
      if (entry.success) {
        expect(entry.data).toBeNull();
      }
    }
  });

  it('query with limit returns only N most recent entries', async () => {
    const threadResult = await adapter.createThread('agent-limit');
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;

    for (let i = 0; i < 5; i++) {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: `msg-${i}` },
        tokenCount: 5,
      });
    }

    const limited = await adapter.getEntries({ threadId, limit: 3 });
    expect(limited.success).toBe(true);
    if (!limited.success) return;

    expect(limited.data).toHaveLength(3);
    expect(limited.data[0].message.content).toBe('msg-2');
    expect(limited.data[1].message.content).toBe('msg-3');
    expect(limited.data[2].message.content).toBe('msg-4');
  });

  it('thread entries are isolated from each other', async () => {
    const threadAResult = await adapter.createThread('agent-iso-a');
    const threadBResult = await adapter.createThread('agent-iso-b');
    expect(threadAResult.success).toBe(true);
    expect(threadBResult.success).toBe(true);
    if (!threadAResult.success || !threadBResult.success) return;

    const threadA = threadAResult.data.id;
    const threadB = threadBResult.data.id;

    await adapter.addEntry({
      threadId: threadA,
      message: { role: 'user', content: 'alpha' },
      tokenCount: 5,
    });
    await adapter.addEntry({
      threadId: threadA,
      message: { role: 'user', content: 'beta' },
      tokenCount: 5,
    });

    await adapter.addEntry({
      threadId: threadB,
      message: { role: 'user', content: 'gamma' },
      tokenCount: 5,
    });

    const entriesA = await adapter.getEntries({ threadId: threadA });
    const entriesB = await adapter.getEntries({ threadId: threadB });
    expect(entriesA.success).toBe(true);
    expect(entriesB.success).toBe(true);
    if (!entriesA.success || !entriesB.success) return;

    expect(entriesA.data).toHaveLength(2);
    expect(entriesA.data[0].message.content).toBe('alpha');
    expect(entriesA.data[1].message.content).toBe('beta');

    expect(entriesB.data).toHaveLength(1);
    expect(entriesB.data[0].message.content).toBe('gamma');
  });

  it('context builder produces messages from history', async () => {
    const threadResult = await adapter.createThread('agent-5');
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;

    const conversation = [
      { role: 'user' as const, content: 'What is TypeScript?' },
      { role: 'assistant' as const, content: 'TypeScript is a typed superset of JavaScript.' },
      { role: 'user' as const, content: 'How does it handle generics?' },
      { role: 'assistant' as const, content: 'Generics allow you to write reusable components.' },
    ];

    for (const msg of conversation) {
      await adapter.addEntry({
        threadId,
        message: msg,
        tokenCount: 15,
      });
    }

    const builder = new ContextBuilder(
      { maxTokens: 4096, strategy: 'recent', includeSystemPrompt: true },
      { memoryAdapter: adapter }
    );

    const context = await builder.build({
      threadId,
      agentId: 'agent-5',
      systemPrompt: 'You are a TypeScript expert.',
    });

    expect(context.messages.length).toBeGreaterThanOrEqual(4);
    expect(context.messages[0].role).toBe('system');
    expect(context.messages[0].content).toBe('You are a TypeScript expert.');

    const historyMessages = context.messages.slice(1);
    expect(historyMessages).toHaveLength(4);
    expect(historyMessages[0].content).toBe('What is TypeScript?');
    expect(historyMessages[3].content).toBe('Generics allow you to write reusable components.');

    expect(context.tokenCount).toBeGreaterThan(0);
    expect(context.tokenCount).toBeLessThan(4096);
    expect(context.truncated).toBe(false);
    expect(context.metadata.originalMessageCount).toBe(4);
    expect(context.metadata.includedMessageCount).toBe(4);
  });
});
