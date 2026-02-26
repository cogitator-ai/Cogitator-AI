import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { setJudge } from '../../helpers/assertions';
import { Cogitator } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const HEAVY_MODEL = 'ministral-3:8b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

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

describeHeavy('Core: Agent Multi-Turn (heavy model)', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: `ollama/${HEAVY_MODEL}`,
        providers: {
          ollama: {
            baseUrl: OLLAMA_CLOUD_URL,
            apiKey: process.env.OLLAMA_API_KEY,
          },
        },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('calls multiply tool with correct arguments', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use tools for ALL calculations. Never compute manually.',
      tools: [tools.multiply],
      model: `ollama/${HEAVY_MODEL}`,
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'Use the multiply tool to compute 6 * 7.',
      `thread_mul_${Date.now()}`
    );

    expect(result.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
    expect(result.output).toContain('42');
  });

  it('calls add tool with correct arguments', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use tools for ALL calculations. Never compute manually.',
      tools: [tools.add],
      model: `ollama/${HEAVY_MODEL}`,
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'Use the add tool to add 42 + 8.',
      `thread_add_${Date.now()}`
    );

    const addCall = result.toolCalls.find((tc) => tc.name === 'add');
    expect(addCall).toBeDefined();
    expect(result.output).toContain('50');
  });
});
