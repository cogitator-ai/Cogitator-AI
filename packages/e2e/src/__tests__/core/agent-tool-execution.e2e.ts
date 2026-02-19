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
      instructions: 'You are a math assistant. Always use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    const result = await cogitator.run(agent, {
      input: 'What is 15 times 7? Use the multiply tool.',
    });

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

    const result = await cogitator.run(agent, {
      input: 'Calculate (3 * 4) + 5. First multiply 3 by 4, then add 5 to the result.',
    });

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);

    await expectJudge(result.output, {
      question: 'What is (3 * 4) + 5?',
      criteria: 'Answer contains 17',
    });
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
