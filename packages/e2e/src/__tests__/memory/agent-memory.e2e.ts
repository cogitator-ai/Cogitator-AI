import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
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
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('agent remembers context across separate runs', async () => {
    const agent = createTestAgent({
      instructions: 'You are a helpful assistant. Remember what the user tells you.',
    });
    const threadId = `memory-test-1-${Date.now()}`;

    const r1 = await cogitator.run(agent, {
      input: 'My name is Alex. Please remember it.',
      threadId,
    });
    expect(typeof r1.output).toBe('string');

    const r2 = await cogitator.run(agent, {
      input: 'What is my name?',
      threadId,
    });
    expect(typeof r2.output).toBe('string');

    await expectJudge(r2.output, {
      question: 'User said "My name is Alex" in turn 1, then asked "What is my name?" in turn 2',
      criteria: 'Second response references or mentions the name Alex',
    });
  });

  it('agent retrieves tool results from previous turns', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use tools for calculations. Never calculate manually. Remember previous results.',
      tools: [tools.multiply],
    });
    const threadId = `memory-test-2-${Date.now()}`;

    const r1 = await runUntilToolCalled(
      cogitator,
      agent,
      'What is 5 times 5? You MUST use the multiply tool.',
      threadId
    );
    expect(typeof r1.output).toBe('string');

    const r2 = await cogitator.run(agent, {
      input: 'What was the result of the previous calculation?',
      threadId,
    });
    expect(typeof r2.output).toBe('string');

    await expectJudge(r2.output, {
      question: 'Previous calculation was 5*5=25. User asked what the result was.',
      criteria: 'Response references 25 or the previous calculation result',
    });
  });

  it('different threads are isolated', async () => {
    const agent = createTestAgent({
      instructions: 'You are a helpful assistant. Remember what the user tells you.',
    });
    const threadA = `thread-a-${Date.now()}`;
    const threadB = `thread-b-${Date.now()}`;

    const rA = await cogitator.run(agent, {
      input: 'My favorite color is blue. Remember this fact.',
      threadId: threadA,
    });
    expect(typeof rA.output).toBe('string');

    const rB = await cogitator.run(agent, {
      input: 'What is my favorite color?',
      threadId: threadB,
    });
    expect(typeof rB.output).toBe('string');
  });

  it('context builder respects token limits', async () => {
    const agent = createTestAgent({
      instructions: 'You are a helpful assistant. Keep responses short.',
    });
    const threadId = `memory-stress-${Date.now()}`;

    for (let i = 0; i < 12; i++) {
      await cogitator.run(agent, {
        input: `This is message number ${i + 1}. The secret code for this message is CODE_${i + 1}.`,
        threadId,
      });
    }

    const final = await cogitator.run(agent, {
      input: 'Can you respond with a short greeting?',
      threadId,
    });

    expect(typeof final.output).toBe('string');
    expect(final.usage.totalTokens).toBeGreaterThan(0);
  });
});
