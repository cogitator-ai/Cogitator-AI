import { describe, it, expect, beforeAll } from 'vitest';
import { Cogitator } from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

function getHeapMB(): number {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

describeOllama('Reliability: Memory Stability (Ollama)', () => {
  let ollamaAvailable: boolean;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    if (!ollamaAvailable) throw new Error('Ollama not running');
  });

  it('agent loop does not leak memory over 30 runs', async () => {
    const cogitator = createTestCogitator();
    const agent = createTestAgent({ maxIterations: 1 });
    const heaps: number[] = [];

    for (let i = 0; i < 30; i++) {
      await cogitator.run(agent, { input: `Say "${i}"` });
      if (i % 5 === 0) heaps.push(getHeapMB());
    }

    await cogitator.close();

    const firstThird = heaps.slice(0, Math.ceil(heaps.length / 3));
    const lastThird = heaps.slice(-Math.ceil(heaps.length / 3));
    const avgFirst = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
    const avgLast = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;

    expect(avgLast).toBeLessThan(avgFirst * 3);
  }, 120_000);
});

describe('Reliability: Memory Stability', () => {
  it('Cogitator create/close 100 cycles stays bounded', async () => {
    const baseline = getHeapMB();

    for (let i = 0; i < 100; i++) {
      const cog = new Cogitator({
        llm: { defaultModel: 'ollama/mock' },
      });
      await cog.close();
    }

    const after = getHeapMB();
    expect(after).toBeLessThan(baseline + 30);
  }, 30_000);

  it('InMemoryAdapter add/clear 200 cycles stays stable', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();

    const threadResult = await adapter.createThread('test-agent');
    if (!threadResult.success) throw new Error('Failed to create thread');
    const threadId = threadResult.data.id;

    const baseline = getHeapMB();

    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 50; j++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `msg-${i}-${j}` },
          tokenCount: 10,
        });
      }
      await adapter.clearThread(threadId);
    }

    const after = getHeapMB();
    expect(adapter.stats.entries).toBe(0);
    expect(after).toBeLessThan(baseline + 30);

    await adapter.disconnect();
  }, 30_000);

  it('InMemoryAdapter maxEntries eviction keeps correct count', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory', maxEntries: 100 });
    await adapter.connect();

    const threadResult = await adapter.createThread('test-agent');
    if (!threadResult.success) throw new Error('Failed to create thread');
    const threadId = threadResult.data.id;

    for (let i = 0; i < 200; i++) {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: `entry-${i}` },
        tokenCount: 1,
      });
    }

    expect(adapter.stats.entries).toBe(100);

    const entriesResult = await adapter.getEntries({ threadId, limit: 200 });
    if (!entriesResult.success) throw new Error('Failed to get entries');
    const entries = entriesResult.data;

    const lastContent = entries[entries.length - 1].message.content;
    expect(lastContent).toBe('entry-199');

    await adapter.disconnect();
  });
});
