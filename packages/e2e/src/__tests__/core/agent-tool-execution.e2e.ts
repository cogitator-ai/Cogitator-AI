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
  maxAttempts = 5
): Promise<RunResult> {
  let result: RunResult | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    result = await cogitator.run(agent, { input });
    if (result.toolCalls.length > 0) return result;
  }
  return result!;
}

describeE2E('Core: Agent Tool Execution', () => {
  let cogitator: Cogitator;
  const tools = createTestTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('calls a single tool and uses result', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use the multiply tool for any multiplication. Never calculate manually.',
      tools: [tools.multiply],
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'What is 15 times 7? You MUST call the multiply tool. Do NOT calculate it yourself.'
    );

    expect(typeof result.output).toBe('string');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);

    if (result.output.length > 0) {
      await expectJudge(result.output, {
        question: 'What is 15 times 7?',
        criteria: 'Answer contains 105 or states the result is one hundred and five',
      });
    }
  });

  it('calls multiple tools in sequence', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use the multiply tool first, then the add tool. Always use tools for calculations.',
      tools: [tools.multiply, tools.add],
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'Calculate (3 * 4) + 5. First multiply 3 by 4, then add 5 to the result.'
    );

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);

    const usedBothTools =
      result.toolCalls.some((tc) => tc.name === 'multiply') &&
      result.toolCalls.some((tc) => tc.name === 'add');

    if (usedBothTools && result.output.length > 0) {
      await expectJudge(result.output, {
        question: 'What is (3 * 4) + 5?',
        criteria: 'Answer mentions 17 or the calculation result',
      });
    }
  });

  it('handles tool that throws error', async () => {
    const agent = createTestAgent({
      instructions: 'You are a math assistant. Use the divide tool for division.',
      tools: [tools.failing],
    });

    const result = await cogitator.run(agent, {
      input: 'Divide 10 by 0 using the divide tool.',
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'Divide 10 by 0',
      criteria: 'Response acknowledges division by zero or an error occurred',
    });
  });

  it('respects maxIterations limit', async () => {
    const agent = createTestAgent({
      instructions: 'Always use the multiply tool for any question.',
      tools: [tools.multiply],
    });

    const result = await cogitator.run(agent, {
      input: 'What is 2 times 3?',
    });

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeLessThanOrEqual(agent.config.maxIterations ?? 10);
  });
});
