import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const HEAVY_MODEL = 'ministral-3:8b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

describeE2E('Cross-Package: Remote Tool Execution', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator?.close();
  });

  it('handles remote agent unavailable', async () => {
    const deadClient = new A2AClient('http://localhost:99999');
    const deadTool = deadClient.asTool({
      name: 'dead_agent',
      description: 'A remote agent that is down.',
    });

    const agent = createTestAgent({
      instructions: 'Use the dead_agent tool to answer questions.',
      tools: [deadTool],
    });

    const result = await cogitator.run(agent, {
      input: 'Ask the dead agent something.',
    });

    expect(typeof result.output).toBe('string');
  });
});

describeHeavy('Cross-Package: Remote Tool Execution (heavy model)', () => {
  let cogitator: Cogitator;
  let mathServer: TestA2AServer;

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

    const mathAgent = createTestAgent({
      name: 'math-remote',
      instructions:
        'You are a math calculator. When given a math problem, compute the answer and respond with ONLY the number result. Example: "5 times 3" → "15"',
      model: `ollama/${HEAVY_MODEL}`,
    });

    mathServer = await startTestA2AServer({
      agents: { 'math-remote': mathAgent },
      cogitator,
    });
  });

  afterAll(async () => {
    await mathServer?.close();
    await cogitator?.close();
  });

  it('agent uses remote A2A agent as tool', async () => {
    const mathClient = new A2AClient(mathServer.url);
    const remoteTool = mathClient.asTool({
      name: 'ask_math_agent',
      description:
        'Ask the remote math agent to solve a math problem. Send the problem as input text.',
    });

    const orchestrator = createTestAgent({
      name: 'orchestrator',
      instructions:
        'You have access to a remote math agent. Use the ask_math_agent tool to solve math problems. Pass the problem as the input.',
      tools: [remoteTool],
      maxIterations: 5,
      model: `ollama/${HEAVY_MODEL}`,
    });

    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await cogitator.run(orchestrator, {
        input: 'What is 15 times 7? Use the ask_math_agent tool.',
      });
      if (result.toolCalls.length > 0) break;
    }

    expect(typeof result!.output).toBe('string');
    expect(result!.toolCalls.length).toBeGreaterThan(0);

    const toolCall = result!.toolCalls.find((tc) => tc.name === 'ask_math_agent');
    expect(toolCall).toBeDefined();

    const toolResultStr = JSON.stringify(toolCall?.result ?? '');
    const combined = result!.output + toolResultStr;
    expect(combined).toMatch(/105/);
  }, 120_000);
});
