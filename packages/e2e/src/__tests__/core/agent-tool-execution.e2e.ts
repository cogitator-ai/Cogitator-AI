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

  it('calls a single tool with correct arguments', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. You MUST use the multiply tool for any multiplication. Never calculate manually.',
      tools: [tools.multiply],
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'What is 15 times 7? You MUST call the multiply tool with a=15 and b=7.'
    );

    expect(result.toolCalls.length).toBeGreaterThan(0);

    const multiplyCall = result.toolCalls.find((tc) => tc.name === 'multiply');
    expect(multiplyCall).toBeDefined();

    const args = multiplyCall!.arguments as Record<string, number>;
    expect(typeof args.a).toBe('number');
    expect(typeof args.b).toBe('number');
    expect((args.a === 15 && args.b === 7) || (args.a === 7 && args.b === 15)).toBe(true);
  });

  it('tool result is incorporated into final answer', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use the multiply tool, then state the exact numeric result.',
      tools: [tools.multiply],
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'Multiply 15 by 7. Use the multiply tool and tell me the result.'
    );

    expect(result.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
    expect(result.output).toContain('105');
  });

  it('handles tool errors and reports them', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use the divide tool for division. If the tool fails, explain what went wrong.',
      tools: [tools.failing],
    });

    const result = await runUntilToolCalled(
      cogitator,
      agent,
      'Divide 10 by 0. You MUST use the divide tool with a=10, b=0.'
    );

    const output = result.output.toLowerCase();
    const mentionsError =
      output.includes('error') ||
      output.includes('zero') ||
      output.includes('cannot') ||
      output.includes('undefined') ||
      output.includes('impossible') ||
      output.includes('fail');

    expect(mentionsError).toBe(true);
  });

  it('respects maxIterations', async () => {
    const agent = createTestAgent({
      instructions: 'You MUST use a tool for every response.',
      tools: [tools.multiply, tools.add, tools.failing],
      maxIterations: 1,
    });

    const result = await cogitator.run(agent, {
      input: 'Use the multiply tool with 2 and 3.',
    });

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeLessThanOrEqual(1);
  });

  it('calls multiple tools in sequence', async () => {
    const agent = createTestAgent({
      instructions: [
        'You are a calculator. You CANNOT do math yourself. You MUST call a tool for EVERY arithmetic operation.',
        'IMPORTANT: After getting a tool result, if there is another operation to do, you MUST call another tool.',
        'NEVER say the answer without calling ALL required tools first.',
        'Available: multiply(a,b) and add(a,b).',
      ].join(' '),
      tools: [tools.multiply, tools.add],
    });

    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      result = await cogitator.run(agent, {
        input:
          'Compute this in two steps: Step 1 - call multiply(3, 4). Step 2 - call add(result_of_step_1, 5). You MUST call BOTH tools.',
      });
      const usedBoth =
        result.toolCalls.some((tc) => tc.name === 'multiply') &&
        result.toolCalls.some((tc) => tc.name === 'add');
      if (usedBoth) break;
    }

    expect(result).toBeDefined();
    expect(result!.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
    expect(result!.toolCalls.some((tc) => tc.name === 'add')).toBe(true);
  });
});
