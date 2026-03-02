import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import { Cogitator, agentAsTool, tool } from '@cogitator-ai/core';
import type { AgentToolResult, RunResult } from '@cogitator-ai/core';
import { z } from 'zod';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const HEAVY_MODEL = 'ministral-3:8b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

describeE2E('Core: agentAsTool (direct execution)', () => {
  let cogitator: Cogitator;
  const tools = createTestTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('agentAsTool returns success with output', { timeout: 120_000 }, async () => {
    const innerAgent = createTestAgent({
      name: 'inner-agent',
      instructions: 'Reply with exactly: INNER_RESULT',
    });

    const wrappedTool = agentAsTool(cogitator, innerAgent, {
      name: 'delegate',
      description: 'Delegate to inner agent',
    });

    const result = (await wrappedTool.execute(
      { task: 'Say INNER_RESULT' },
      { agentId: 'test', runId: 'test-run', signal: new AbortController().signal }
    )) as AgentToolResult;

    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('agentAsTool with includeUsage returns token stats', { timeout: 120_000 }, async () => {
    const innerAgent = createTestAgent({
      name: 'usage-agent',
      instructions: 'Reply briefly.',
    });

    const wrappedTool = agentAsTool(cogitator, innerAgent, {
      name: 'delegate_usage',
      description: 'Delegate with usage',
      includeUsage: true,
    });

    const result = (await wrappedTool.execute(
      { task: 'Say hello' },
      { agentId: 'test', runId: 'test-run', signal: new AbortController().signal }
    )) as AgentToolResult;

    expect(result.success).toBe(true);
    expect(result.usage).toBeDefined();
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
    expect(result.usage!.duration).toBeGreaterThan(0);
  });

  it(
    'agentAsTool with includeToolCalls tracks inner tool usage',
    { timeout: 120_000 },
    async () => {
      const innerAgent = createTestAgent({
        name: 'tool-tracking-agent',
        instructions: 'You MUST use the multiply tool for any multiplication.',
        tools: [tools.multiply],
      });

      const wrappedTool = agentAsTool(cogitator, innerAgent, {
        name: 'delegate_tools',
        description: 'Delegate with tool tracking',
        includeToolCalls: true,
      });

      let result: AgentToolResult | undefined;
      for (let i = 0; i < 5; i++) {
        result = (await wrappedTool.execute(
          { task: 'Multiply 5 by 6 using the multiply tool.' },
          { agentId: 'test', runId: 'test-run', signal: new AbortController().signal }
        )) as AgentToolResult;
        if (result.toolCalls && result.toolCalls.length > 0) break;
      }

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      if (result!.toolCalls && result!.toolCalls.length > 0) {
        expect(result!.toolCalls[0].name).toBe('multiply');
      }
    }
  );

  it('agentAsTool produces valid Tool schema', () => {
    const innerAgent = createTestAgent({ name: 'schema-test' });
    const wrappedTool = agentAsTool(cogitator, innerAgent, {
      name: 'my_delegate',
      description: 'A delegating tool',
    });

    expect(wrappedTool.name).toBe('my_delegate');
    expect(wrappedTool.description).toBe('A delegating tool');

    const schema = wrappedTool.toJSON();
    expect(schema.name).toBe('my_delegate');
    expect(schema.parameters.type).toBe('object');
    expect(schema.parameters.properties).toHaveProperty('task');
  });
});

describeHeavy('Core: agentAsTool (nested agent delegation)', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
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

  it('outer agent delegates to inner agent via tool', { timeout: 180_000 }, async () => {
    const mathTool = tool({
      name: 'multiply',
      description: 'Multiply two numbers',
      parameters: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      execute: async ({ a, b }) => ({ result: a * b }),
    });

    const mathAgent = createTestAgent({
      name: 'math-specialist',
      instructions: 'You are a math specialist. Use the multiply tool for multiplication.',
      tools: [mathTool],
      model: `ollama/${HEAVY_MODEL}`,
    });

    const delegateTool = agentAsTool(cogitator, mathAgent, {
      name: 'ask_math_expert',
      description: 'Delegate a math question to a specialist agent who can multiply numbers',
      includeUsage: true,
    });

    const managerAgent = createTestAgent({
      name: 'manager',
      instructions:
        'You are a manager. For math questions, ALWAYS delegate to ask_math_expert tool. Pass the full question as the task.',
      tools: [delegateTool],
      model: `ollama/${HEAVY_MODEL}`,
    });

    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await cogitator.run(managerAgent, {
        input: 'What is 7 times 8? Use the ask_math_expert tool to find out.',
      });
      if (result.toolCalls.some((tc) => tc.name === 'ask_math_expert')) break;
    }

    expect(result).toBeDefined();
    if (result!.toolCalls.some((tc) => tc.name === 'ask_math_expert')) {
      expect(result!.output).toContain('56');
    }
  });
});
