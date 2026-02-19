import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Multi-Turn', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('remembers context from previous turns', async () => {
    const agent = createTestAgent();
    const threadId = `thread_multitest_${Date.now()}`;

    const r1 = await cogitator.run(agent, {
      input: 'My name is Alex. Remember it.',
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
      criteria: "Response mentions Alex or the user's name",
    });
  });

  it('maintains tool results across turns', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use tools for calculations. Remember previous results.',
      tools: [tools.multiply, tools.add],
    });
    const threadId = `thread_toolmem_${Date.now()}`;

    const r1 = await cogitator.run(agent, {
      input: 'Multiply 10 by 5.',
      threadId,
    });
    expect(typeof r1.output).toBe('string');
    expect(r1.usage.totalTokens).toBeGreaterThan(0);

    const r2 = await cogitator.run(agent, {
      input: 'Now add 25 to the previous result.',
      threadId,
    });
    expect(typeof r2.output).toBe('string');

    await expectJudge(r2.output, {
      question: 'Previous result was 50 (10*5). User asked to add 25.',
      criteria: 'Response contains 75 or seventy-five',
    });
  });
});
