import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { setJudge } from '../../helpers/assertions';
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

describeE2E('Core: Agent Multi-Turn', () => {
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

  it('remembers specific data across turns', async () => {
    const agent = createTestAgent({
      instructions:
        'You have perfect memory. When the user tells you a code, remember it exactly. When asked, repeat it exactly.',
    });
    const threadId = `thread_secret_${Date.now()}`;

    await cogitator.run(agent, {
      input: 'The secret code is ALPHA-7742. Remember it.',
      threadId,
    });

    const r2 = await cogitator.run(agent, {
      input: 'What is the secret code I told you? Reply with ONLY the code.',
      threadId,
    });

    const output = r2.output.toUpperCase();
    expect(output.includes('ALPHA-7742') || output.includes('7742')).toBe(true);
  });

  it('uses tool results from previous turns in next computation', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use tools for ALL calculations. Never compute manually. State numeric results clearly.',
      tools: [tools.multiply, tools.add],
    });
    const threadId = `thread_toolchain_${Date.now()}`;

    const r1 = await runUntilToolCalled(
      cogitator,
      agent,
      'Use the multiply tool to compute 6 * 7. You MUST call the multiply tool.',
      threadId
    );

    expect(r1.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
    expect(r1.output).toContain('42');

    const r2 = await runUntilToolCalled(
      cogitator,
      agent,
      'Now use the add tool to add 8 to the previous result (42). You MUST call the add tool.',
      threadId
    );

    const addCall = r2.toolCalls.find((tc) => tc.name === 'add');
    const outputHas50 = r2.output.includes('50');

    expect(addCall || outputHas50).toBeTruthy();

    if (addCall) {
      const args = addCall.arguments as Record<string, number>;
      const usedCorrectBase = args.a === 42 || args.b === 42;
      expect(usedCorrectBase).toBe(true);
    }
  });

  it('maintains distinct conversations on different threads', async () => {
    const agent = createTestAgent({
      instructions:
        'You have perfect memory. Remember what the user tells you. When asked, recall exactly what they said.',
    });
    const threadA = `thread_red_${Date.now()}`;
    const threadB = `thread_blue_${Date.now()}`;

    await cogitator.run(agent, {
      input: 'My favorite color is RED. Remember this.',
      threadId: threadA,
    });

    await cogitator.run(agent, {
      input: 'My favorite color is BLUE. Remember this.',
      threadId: threadB,
    });

    const r3 = await cogitator.run(agent, {
      input: 'What is my favorite color? Reply with ONLY the color name.',
      threadId: threadA,
    });

    const output = r3.output.toUpperCase();
    expect(output).toContain('RED');
    expect(output).not.toContain('BLUE');
  });
});
