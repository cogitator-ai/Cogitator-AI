import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import type { Cogitator, RunResult } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

async function runUntilToolCalled(
  cogitator: Cogitator,
  agent: ReturnType<typeof createTestAgent>,
  input: string,
  threadId: string,
  maxAttempts = 5
): Promise<RunResult> {
  let result: RunResult | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    result = await cogitator.run(agent, { input, threadId });
    if (result.toolCalls.length > 0) return result;
  }
  return result!;
}

describeE2E('Memory: Agent Memory Integration', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('agent remembers specific facts across turns', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a helpful assistant. When asked to remember something, confirm you will. When asked to recall, respond with the exact value.',
    });
    const threadId = `memory-fact-${Date.now()}`;

    await cogitator.run(agent, {
      input: 'Remember: the password is XRAY-9943',
      threadId,
    });

    const r2 = await cogitator.run(agent, {
      input: 'What is the password?',
      threadId,
    });

    expect(r2.output.toUpperCase()).toContain('XRAY-9943');
  });

  it('agent uses tool results from previous turns', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use the multiply tool for calculations. Never calculate manually. When asked about previous results, state the number.',
      tools: [tools.multiply],
    });
    const threadId = `memory-tool-${Date.now()}`;

    const r1 = await runUntilToolCalled(
      cogitator,
      agent,
      'What is 8 times 9? You MUST use the multiply tool.',
      threadId
    );

    const multiplyCalls = r1.toolCalls.filter((tc) => tc.name === 'multiply');
    expect(multiplyCalls.length).toBeGreaterThanOrEqual(1);

    const r2 = await cogitator.run(agent, {
      input: 'What was the result of the multiplication?',
      threadId,
    });

    expect(r2.output).toContain('72');
  });

  it('different threads are isolated', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a helpful assistant. Remember what the user tells you. When asked about the animal, respond with ONLY the animal name in uppercase.',
    });
    const threadA = `thread-a-${Date.now()}`;
    const threadB = `thread-b-${Date.now()}`;

    await cogitator.run(agent, {
      input: 'The animal is DOG. Remember this.',
      threadId: threadA,
    });

    await cogitator.run(agent, {
      input: 'The animal is CAT. Remember this.',
      threadId: threadB,
    });

    const rA = await cogitator.run(agent, {
      input: 'What is the animal?',
      threadId: threadA,
    });

    const rB = await cogitator.run(agent, {
      input: 'What is the animal?',
      threadId: threadB,
    });

    const outputA = rA.output.toUpperCase();
    const outputB = rB.output.toUpperCase();

    expect(outputA).toContain('DOG');
    expect(outputA).not.toContain('CAT');
    expect(outputB).toContain('CAT');
    expect(outputB).not.toContain('DOG');
  });

  it('memory persists agent responses too', async () => {
    const agent = createTestAgent({
      instructions: 'You are a helpful assistant. Always respond clearly and precisely.',
    });
    const threadId = `memory-persist-${Date.now()}`;

    await cogitator.run(agent, {
      input: 'Say exactly this phrase: "The quick brown fox jumps over the lazy dog"',
      threadId,
    });

    const r2 = await cogitator.run(agent, {
      input: 'Repeat exactly what you said in your previous response.',
      threadId,
    });

    const hasOverlap = r2.output.includes('quick brown fox') || r2.output.includes('lazy dog');
    expect(hasOverlap).toBe(true);
  });

  it('memory adapter operations work correctly', async () => {
    const { InMemoryAdapter } = await import('@cogitator-ai/memory');
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();

    const threadResult = await adapter.createThread('test-agent');
    expect(threadResult.success).toBe(true);
    if (!threadResult.success) return;

    const threadId = threadResult.data.id;

    for (let i = 0; i < 5; i++) {
      const res = await adapter.addEntry({
        threadId,
        message: { role: 'user', content: `message-${i}` },
        tokenCount: 10,
      });
      expect(res.success).toBe(true);
    }

    const all = await adapter.getEntries({ threadId });
    expect(all.success).toBe(true);
    if (!all.success) return;
    expect(all.data).toHaveLength(5);
    expect(all.data[0].message.content).toBe('message-0');
    expect(all.data[4].message.content).toBe('message-4');

    const deleteResult = await adapter.deleteThread(threadId);
    expect(deleteResult.success).toBe(true);

    const gone = await adapter.getThread(threadId);
    expect(gone.success).toBe(true);
    if (gone.success) {
      expect(gone.data).toBeNull();
    }

    await adapter.disconnect();
  });
});
